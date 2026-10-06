/**
 * The task database in memory, for the migration's and the store port's
 * tests: the Rust store's contract as its own tests pin it (keepdeck-tasks
 * tests/store.rs) — a rev per board checked on every change, a request
 * answered "already applied" when sent again, history appended only, a
 * migration pending until activated. Plus the faults those tests need: a
 * coded refusal, and an answer lost on the way after the change landed.
 */
import type { Applied } from "../../ipc/generated/tasks/Applied";
import type { ChangeSet } from "../../ipc/generated/tasks/ChangeSet";
import type { LegacyBoard } from "../../ipc/generated/tasks/LegacyBoard";
import type { MigrationSource } from "../../ipc/generated/tasks/MigrationSource";
import type { StoreError } from "../../ipc/generated/tasks/StoreError";
import type { StoreStatus } from "../../ipc/generated/tasks/StoreStatus";
import type { StoredBoard } from "../../ipc/generated/tasks/StoredBoard";
import type { TaskDatabasePort } from "./dbBoardStore";

export function isTestStoreError(value: unknown): value is StoreError {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}

export function testDatabase(files: LegacyBoard[] = []) {
  let legacy = [...files];
  let boards: StoredBoard[] = [];
  let migration: "none" | "pending" | "active" = "none";
  let sources: MigrationSource[] = [];
  let status: StoreStatus | null = null;
  const applied = new Map<string, Applied>();
  /** The faults the next applies meet, one each, in order. */
  const faults: ({ kind: "refuse"; error: StoreError } | { kind: "lose" })[] = [];
  /** Called between the import and the read-back — a file changing mid-move. */
  let duringImport: (() => void) | null = null;
  const requests: ChangeSet[] = [];
  /** Copies of the boards, by when they were taken. */
  const backups = new Map<number, StoredBoard[]>();
  /** What the import stores, in place of what it was given — a database that loses a row. */
  let tamper = (incoming: StoredBoard[]) => incoming;
  /** What the next retire of the files refuses with. */
  let retireFault: StoreError | null = null;
  /** What the next activation refuses with. */
  let activateFault: StoreError | null = null;
  /** What the next load refuses with. */
  let loadFault: StoreError | null = null;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const applyBoard = (change: ChangeSet["boards"][number]) => {
    let board = boards.find((b) => b.board === change.board);
    if (!board) {
      if (change.expectedRev !== 0) throw { code: "conflict", board: change.board, rev: 0 } satisfies StoreError;
      board = { board: change.board, workspace: change.workspace, nextId: change.nextId, rev: 0, tasks: [], relations: [] };
      boards.push(board);
    } else if (board.rev !== change.expectedRev) {
      throw { code: "conflict", board: change.board, rev: board.rev } satisfies StoreError;
    }
    if (change.nextId < board.nextId) throw { code: "constraint", detail: "counter back" } satisfies StoreError;
    const rev = board.rev + 1;
    board.tasks = board.tasks.filter((t) => !change.removed.includes(t.uid));
    for (const w of change.tasks) {
      const old = board.tasks.find((t) => t.uid === w.uid);
      const task = old ?? ({ uid: w.uid, key: w.key ?? "", oldKeys: [], labels: [], artifacts: [], comments: [], log: [], briefs: [] } as unknown as StoredBoard["tasks"][number]);
      Object.assign(task, {
        teamId: w.teamId, title: w.title, body: w.body, bodyV: w.bodyV, status: w.status, priority: w.priority,
        assignee: w.assignee, author: w.author, created: w.created, updated: w.updated, rev,
      });
      if (w.labels) task.labels = [...w.labels].sort();
      if (w.artifacts) task.artifacts = [...w.artifacts];
      for (const c of w.comments) if (!task.comments.some((x) => x.n === c.n)) task.comments.push(c);
      for (const e of w.log) {
        if (task.log.some((x) => x.seq === e.seq)) continue;
        if (e.seq !== task.log.length) throw { code: "constraint", detail: "log gap" } satisfies StoreError;
        task.log.push(e);
      }
      for (const b of w.briefs) if (!task.briefs.some((x) => x.v === b.v)) task.briefs.push(b);
      if (!old) board.tasks.push(task);
      (task as { boardPos?: number }).boardPos = w.boardPos;
    }
    board.tasks.sort((a, b) => ((a as { boardPos?: number }).boardPos ?? 0) - ((b as { boardPos?: number }).boardPos ?? 0));
    const key = (r: { kind: string; from: string; to: string }) => `${r.kind}|${r.from}|${r.to}`;
    board.relations = board.relations.filter((r) => !change.relationsRemoved.some((k) => key(k) === key(r)));
    for (const r of change.relationsPut) {
      board.relations = [...board.relations.filter((x) => key(x) !== key(r)), r];
    }
    board.nextId = change.nextId;
    board.rev = rev;
    return { board: board.board, rev };
  };

  const port: TaskDatabasePort = {
    enable: async () => {},
    disable: async () => {},
    status: async () => status ?? { kind: "ready", migration },
    legacyBoards: async () => clone(legacy),
    import: async (incoming, src) => {
      if (migration !== "none" || boards.length > 0) throw { code: "invalid", detail: "already imported" } satisfies StoreError;
      boards = tamper(clone(incoming));
      sources = clone(src);
      migration = "pending";
      duringImport?.();
    },
    loadAll: async () => clone(boards),
    activate: async () => {
      const fault = activateFault;
      activateFault = null;
      if (fault !== null) throw fault;
      migration = "active";
      sources = [];
    },
    retireLegacy: async () => {
      if (migration !== "active") throw { code: "invalid", detail: "not moved yet" } satisfies StoreError;
      const fault = retireFault;
      retireFault = null;
      if (fault !== null) throw fault;
      legacy = [];
    },
    discard: async () => {
      boards = [];
      sources = [];
      migration = "none";
    },
    load: async (workspace) => {
      const fault = loadFault;
      loadFault = null;
      if (fault !== null) throw fault;
      return clone(boards.find((b) => b.workspace === workspace) ?? null);
    },
    apply: async (change) => {
      requests.push(clone(change));
      const before = applied.get(change.requestId);
      if (before) return { kind: "alreadyApplied", revs: before.revs } as Applied;
      const fault = faults.shift() ?? null;
      if (fault?.kind === "refuse") throw fault.error;
      const snapshot = clone(boards);
      let revs;
      try {
        revs = change.boards.map(applyBoard);
      } catch (e) {
        boards = snapshot;
        throw e;
      }
      const answer = { kind: "applied", revs } as Applied;
      applied.set(change.requestId, answer);
      // Landed — but the answer never reaches the caller.
      if (fault?.kind === "lose") throw new Error("the answer was lost");
      return answer;
    },
    drop: async (workspace) => {
      boards = boards.filter((b) => b.workspace !== workspace);
    },
    // A word match over titles, briefs and comments — FTS5's own ranking is
    // the Rust store's to test; here only which board and which task.
    search: async (query, scope, limit) =>
      boards
        .filter((b) => scope.includes(b.board))
        .flatMap((b) =>
          b.tasks.flatMap((t) => [
            ...(`${t.title}\n${t.body}`.toLowerCase().includes(query.toLowerCase())
              ? [{ uid: t.uid, board: b.board, comment: null, snippet: `[${query}]` }]
              : []),
            ...t.comments
              .filter((c) => c.body.toLowerCase().includes(query.toLowerCase()))
              .map((c) => ({ uid: t.uid, board: b.board, comment: c.n, snippet: `[${query}]` })),
          ]),
        )
        .slice(0, limit),
    restoreBackup: async (at) => {
      const backup = backups.get(at);
      if (!backup) throw { code: "invalid", detail: `no backup at ${at}` } satisfies StoreError;
      boards = clone(backup);
      status = null;
    },
    startEmpty: async () => {
      boards = [];
      migration = "none";
      status = null;
    },
  };

  return {
    port,
    boards: () => boards,
    migration: () => migration,
    sources: () => sources,
    legacy: () => legacy,
    requests,
    setLegacy(next: LegacyBoard[]) {
      legacy = next;
    },
    setStatus(next: StoreStatus | null) {
      status = next;
    },
    refuseNextApply(error: StoreError) {
      faults.push({ kind: "refuse", error });
    },
    loseNextAnswer() {
      faults.push({ kind: "lose" });
    },
    /** Copy the boards as they are, as the backup taken at `at`. */
    takeBackup(at: number) {
      backups.set(at, clone(boards));
    },
    refuseNextLoad(error: StoreError) {
      loadFault = error;
    },
    refuseNextActivate(error: StoreError) {
      activateFault = error;
    },
    refuseNextRetire(error: StoreError) {
      retireFault = error;
    },
    onImport(fn: () => void) {
      duringImport = fn;
    },
    tamperImport(fn: (incoming: StoredBoard[]) => StoredBoard[]) {
      tamper = fn;
    },
  };
}
