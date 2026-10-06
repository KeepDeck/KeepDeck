/**
 * The task board's store PORT over the task database — the one owner of
 * how a board the service decided reaches the disk.
 *
 * Per board it holds what the database CONFIRMED: the board, its id and
 * its rev. A write sends the change from the confirmed board to the one
 * asked for (`storeDiff`) as one request with its own id. Only an answer
 * moves the confirmed board, so a write that failed is carried by the next.
 * A request whose answer was lost is sent again, the same request, before
 * anything else: the database answers "already applied" instead of
 * applying it twice (review task-262/263).
 *
 * At enable the boards move from their files into the database, all at
 * once (`migrateBoards`). If that cannot happen, the boards are read from their
 * files and nothing is written; if the database cannot be used at all,
 * nothing is read or written. The reason is the port's `writeRefusal`,
 * and the service refuses every change with it.
 */
import { EMPTY_BOARD, decodeBoard, type TaskBoard, type TaskLanding } from "../../domain/tasks";
import type { Applied } from "../../ipc/generated/tasks/Applied";
import type { ChangeSet } from "../../ipc/generated/tasks/ChangeSet";
import type { SearchHit } from "../../ipc/generated/tasks/SearchHit";
import type { StoreError } from "../../ipc/generated/tasks/StoreError";
import type { StoreStatus } from "../../ipc/generated/tasks/StoreStatus";
import type { StoredBoard } from "../../ipc/generated/tasks/StoredBoard";
import { migrateBoards, type MigrationOutcome, type MigrationPort } from "./migration";
import { BOARD_NOT_OPEN, BOARD_READ_STALE, decodeFaultText, migrationRefusalText, storeErrorText } from "./refusalText";
import { boardChange, HistoryRewritten } from "./storeDiff";
import { boardFromStored } from "./storeWire";
import type { BoardRead, Recovery, TasksStorePort } from "./tasksService";

/** What this owner needs from the Rust store. */
export interface TaskDatabasePort extends MigrationPort {
  enable(): Promise<void>;
  disable(): Promise<void>;
  load(workspace: string): Promise<StoredBoard | null>;
  apply(change: ChangeSet): Promise<Applied>;
  drop(workspace: string): Promise<void>;
  search(query: string, boards: string[], limit: number): Promise<SearchHit[]>;
  restoreBackup(at: number): Promise<void>;
  startEmpty(): Promise<void>;
}

export interface DbBoardStoreDeps {
  db: TaskDatabasePort;
  /** The workspaces the deck has now — which boards the move attaches. */
  workspaces(): readonly string[];
  mintUid(): string;
  isStoreError(value: unknown): value is StoreError;
  /** Hears how the move went, once per enable. */
  onMigration?(outcome: MigrationOutcome): void;
}

/** A board as the database last confirmed it. */
interface Confirmed {
  board: string;
  rev: number;
  /** When each task's parts landed, by the board's change numbers. */
  landings: Map<string, TaskLanding>;
  held: TaskBoard;
  /** A request sent whose answer never came: sent again before any other. */
  pending: { change: ChangeSet; target: TaskBoard } | null;
}

export type DbBoardStore = TasksStorePort & { enable(): Promise<void>; disable(): Promise<void> };

export function createDbBoardStore(deps: DbBoardStoreDeps): DbBoardStore {
  const confirmed = new Map<string, Confirmed>();
  /** Why nothing can be written; null when writes go to the database. */
  let readOnly: string | null = BOARD_NOT_OPEN;
  /** The boards read from their files, when they could not move. */
  let fallback: Map<string, BoardRead> | null = null;
  /** The database cannot be used and is the person's to recover. */
  let recovery: Recovery | null = null;
  /** Which database this is: bumped whenever another may stand in its
   * place (a settle, a disable). A read that set out under an earlier one
   * answers nothing confirmed — what it read is gone. */
  let generation = 0;

  /** Ask the database how it stands, after a refusal said it is unusable. */
  const learnRecovery = async () => {
    recovery = recoveryOf(await deps.db.status());
  };

  /**
   * Every call to the database goes through here: a refusal saying the
   * database cannot be used at all — damaged, gone, a newer build's —
   * makes the store read-only, with the way to recover learned, whichever
   * call met it first. The refusal still reaches the caller.
   */
  const call = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (e: unknown) {
      if (deps.isStoreError(e) && (e.code === "corrupt" || e.code === "missing" || e.code === "schemaTooNew")) {
        readOnly = storeErrorText(e);
        await learnRecovery();
      }
      throw e;
    }
  };

  /** The database answered: the change is what it holds now. */
  const accept = (place: Confirmed, applied: Applied, change: ChangeSet, target: TaskBoard) => {
    const rev = applied.revs.find((r) => r.board === place.board)?.rev;
    if (rev === undefined) throw new Error(`the database answered without board ${place.board}`);
    place.rev = rev;
    place.held = target;
    place.pending = null;
    for (const part of change.boards.filter((b) => b.board === place.board)) {
      for (const task of part.tasks) {
        const was = place.landings.get(task.uid);
        place.landings.set(task.uid, {
          created: was?.created ?? rev,
          rev,
          // What the change carried is what it appended.
          comments: [...(was?.comments ?? []), ...task.comments.map(() => rev)],
          log: [...(was?.log ?? []), ...task.log.map(() => rev)],
        });
      }
      for (const uid of part.removed) place.landings.delete(uid);
    }
  };

  /** Read a board's confirmed state from the database again. */
  /** A board as the database holds it NOW — every read goes through here:
   * one that set out under a database since replaced is refused, so what
   * it read never becomes the base a write is computed from. */
  const loadCurrent = async (workspace: string): Promise<StoredBoard | null> => {
    const asked = generation;
    const stored = await call(() => deps.db.load(workspace));
    if (asked !== generation) throw new Error(BOARD_READ_STALE);
    return stored;
  };

  const reread = async (workspace: string, place: Confirmed) => {
    const stored = await loadCurrent(workspace);
    if (stored === null) return;
    const read = boardFromStored(stored, deps.mintUid);
    if (!read.ok) throw new Error(decodeFaultText(read.fault, "the database"));
    place.board = stored.board;
    place.rev = stored.rev;
    place.landings = landingsOf(stored);
    place.held = read.board;
  };

  /** Send one request. A coded refusal means it was NOT applied: it is
   * answered (null: applied). Anything else — the answer lost on the way —
   * leaves it pending and throws. */
  const send = async (workspace: string, place: Confirmed, change: ChangeSet, target: TaskBoard): Promise<StoreError | null> => {
    place.pending = { change, target };
    let applied: Applied;
    try {
      applied = await call(() => deps.db.apply(change));
    } catch (e: unknown) {
      if (!deps.isStoreError(e)) throw e;
      place.pending = null;
      // Computed against a state the database no longer holds: read it
      // again, and the next write is computed against what is there.
      if (e.code === "conflict" || e.code === "constraint") await reread(workspace, place);
      return e;
    }
    accept(place, applied, change, target);
    return null;
  };

  /** The change from what the database confirmed to `target`, sent. A
   * constraint on a database that is sound means the confirmed board was
   * not what it holds: the board is written over what it holds ONCE —
   * the change from what was just read back — and only a refusal of that
   * reaches the caller (v10 §05). A replacement never deletes or rewrites
   * history (§05 too): where the board here contradicts history the
   * database holds, there is no replacement to make, and that is said. */
  const sendChange = async (workspace: string, place: Confirmed, target: TaskBoard) => {
    const change = boardChange(place.held, target, { board: place.board, workspace, rev: place.rev });
    if (change === null) return;
    let refused = await send(workspace, place, { requestId: deps.mintUid(), boards: [change] }, target);
    if (refused?.code === "constraint" && readOnly === null) {
      let whole: ChangeSet["boards"][number] | null;
      try {
        whole = boardChange(place.held, target, { board: place.board, workspace, rev: place.rev });
      } catch (e: unknown) {
        if (!(e instanceof HistoryRewritten)) throw e;
        throw new Error(`${storeErrorText(refused)} — and ${e.message}, so nothing was written over it`);
      }
      refused = whole === null ? null : await send(workspace, place, { requestId: deps.mintUid(), boards: [whole] }, target);
    }
    if (refused !== null) throw new Error(storeErrorText(refused));
  };

  /** Where the database stands, settled: the boards moved into it (or
   * moved earlier), or the reason nothing can be written. Every board is
   * read from it afresh after. */
  const settle = async () => {
    generation += 1;
    confirmed.clear();
    fallback = null;
    const outcome = await migrateBoards(deps.db, { workspaces: deps.workspaces(), mintUid: deps.mintUid });
    deps.onMigration?.(outcome);
    recovery = outcome.kind === "unusable" ? recoveryOf(outcome.status) : null;
    if (outcome.kind === "active") {
      readOnly = null;
      return;
    }
    readOnly = migrationRefusalText(outcome);
    if (outcome.kind === "failed") {
      // Still the source: read, never written.
      fallback = new Map();
      for (const file of await deps.db.legacyBoards()) {
        const decoded = decodeBoard(file.json, deps.mintUid);
        fallback.set(
          file.workspace,
          decoded.ok ? { kind: "board", board: decoded.board } : { kind: "unreadable", error: decodeFaultText(decoded.fault) },
        );
      }
    }
  };

  return {
    async enable() {
      await deps.db.enable();
      await settle();
    },
    async disable() {
      generation += 1;
      confirmed.clear();
      fallback = null;
      readOnly = BOARD_NOT_OPEN;
      await deps.db.disable();
    },
    async read({ workspaceId }) {
      if (fallback !== null) return fallback.get(workspaceId) ?? { kind: "none" };
      if (readOnly !== null) return { kind: "unreadable", error: readOnly };
      const stored = await loadCurrent(workspaceId);
      if (stored === null) {
        confirmed.delete(workspaceId);
        return { kind: "none" };
      }
      const read = boardFromStored(stored, deps.mintUid);
      if (!read.ok) return { kind: "unreadable", error: decodeFaultText(read.fault, "the database") };
      confirmed.set(workspaceId, { board: stored.board, rev: stored.rev, landings: landingsOf(stored), held: read.board, pending: null });
      return { kind: "board", board: read.board };
    },
    async write({ workspaceId, board }) {
      if (readOnly !== null) throw new Error(readOnly);
      let place = confirmed.get(workspaceId);
      if (!place) {
        // Not read since the database last changed under us (a restore):
        // what it holds now is the base. None there: a board of its own.
        const stored = await loadCurrent(workspaceId);
        const read = stored === null ? null : boardFromStored(stored, deps.mintUid);
        if (read && !read.ok) throw new Error(decodeFaultText(read.fault, "the database"));
        place =
          stored && read?.ok
            ? { board: stored.board, rev: stored.rev, landings: landingsOf(stored), held: read.board, pending: null }
            : { board: deps.mintUid(), rev: 0, landings: new Map(), held: EMPTY_BOARD, pending: null };
        confirmed.set(workspaceId, place);
      }
      if (place.pending) {
        const refused = await send(workspaceId, place, place.pending.change, place.pending.target);
        if (refused !== null) throw new Error(storeErrorText(refused));
      }
      await sendChange(workspaceId, place, board);
    },
    async drop({ workspaceId }) {
      confirmed.delete(workspaceId);
      await call(() => deps.db.drop(workspaceId));
    },
    writeRefusal: () => readOnly,
    async search({ workspaceId, query, limit }) {
      // A board not in the database yet has nothing to find.
      const place = confirmed.get(workspaceId);
      if (fallback !== null || readOnly !== null || !place) return [];
      const hits = await call(() => deps.db.search(query, [place.board], limit));
      return hits.map((hit) => ({ uid: hit.uid, comment: hit.comment, snippet: hit.snippet }));
    },
    recovery: () => recovery,
    async restore(choice) {
      if (choice.kind === "backup") await deps.db.restoreBackup(choice.at);
      else await deps.db.startEmpty();
      // The database is whole again — the backup's boards, or a new one
      // that boards still in their files move into, as at enable.
      await settle();
    },
    revisions(workspaceId) {
      const place = confirmed.get(workspaceId);
      return place ? { board: place.rev, tasks: place.landings } : null;
    },
  };
}

/** What the person can recover an unusable database from, or null when
 * it is usable — or a newer build's, which is not this one's to replace. */
function recoveryOf(status: StoreStatus): Recovery | null {
  return status.kind === "damaged" || status.kind === "missing" ? { kind: status.kind, backups: status.backups } : null;
}

/** When each task's parts landed, as the database last said. */
function landingsOf(stored: StoredBoard): Map<string, TaskLanding> {
  return new Map(
    stored.tasks.map((task) => [task.uid, { created: task.createdRev, rev: task.rev, comments: task.commentRevs, log: task.logRevs }]),
  );
}
