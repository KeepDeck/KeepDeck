/**
 * The task board's ONE owner: the live board of every workspace, the
 * rules applied to it, and the writes that make it durable.
 *
 * The board in memory is the authority for the session — every command
 * and the dialog read it here, never the disk — and the store is where it
 * survives a restart. A mutation is a synchronous read-modify-write on
 * the in-memory board (the deck's whole webview state moves on one
 * thread, so two commands cannot interleave inside one), followed by a
 * queued write of the resulting board; writes to one workspace run in
 * order, so the last board written is the last board decided.
 *
 * A board that does not decode is held as UNREADABLE and never written:
 * saving a "repaired" board over one the user hand-edited would erase what
 * did not fit. The refusal names the file and the fault.
 *
 * No delivery lives here. Nothing wakes an agent, nothing is queued for
 * one — telling an agent about a task is a letter somebody sends (the
 * user's decision). The events this owner emits are for the HUMAN's
 * notifications, and only three of them.
 */
import { membersOf, type Workspace } from "../../domain/deck";
import {
  EMPTY_BOARD,
  createTask,
  decodeBoard,
  encodeBoard,
  findTask,
  replaceTask,
  transition,
  type CreateTaskInput,
  type Task,
  type TaskActor,
  type TaskBoard,
  type TaskChange,
  type TaskRefusal,
} from "../../domain/tasks";
import { describeError, log } from "../../ipc/log";
import { decodeFaultText } from "./refusalText";

/** The store as this owner reads and writes it — a PORT, bound to IPC at
 * the composition root and nowhere else. */
export interface TasksStorePort {
  read(args: { workspaceId: string }): Promise<string | null>;
  write(args: { workspaceId: string; json: string }): Promise<void>;
}

export interface TasksServiceDeps {
  /** The deck as it stands — for rosters, read per call. */
  workspaces(): readonly Workspace[];
  store: TasksStorePort;
  now?(): number;
  /** `setTimeout`, injected so tests drive the clock. Returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
}

/** How long after a failed write the board tries again on its own. */
export const RETRY_WRITE_MS = 3_000;

export type BoardState =
  | { kind: "loading" }
  | {
      kind: "ready";
      board: TaskBoard;
      /** Why the board on disk lags the one here — the last write's
       * failure, verbatim — or null while disk and memory agree. The
       * board retries on its own; this is how a surface says so. */
      unsaved: string | null;
    }
  /** The file did not decode; its words, verbatim. Read-only until fixed. */
  | { kind: "unreadable"; error: string };

/** Why a command could not act — the domain's refusals plus the two only
 * this owner can raise. */
export type TaskProblem =
  | TaskRefusal
  | { kind: "board-unreadable"; error: string }
  | { kind: "unknown-task"; id: string };

export type TaskResult =
  | {
      ok: true;
      task: Task;
      board: TaskBoard;
      /** Whether the write that carried this change landed. False means
       * the board holds it in memory and retries — a caller that answers
       * an agent must say so, or a work order is confirmed and lost. */
      saved: boolean;
      saveError: string | null;
    }
  | { ok: false; refusal: TaskProblem };

/** What the human is told about. Three events and no more: a task put on
 * the board by an agent, one stuck, one accepted. */
export type TaskEvent = {
  kind: "created" | "blocked" | "done";
  workspaceId: string;
  task: Task;
  actor: TaskActor;
};

export interface TasksService {
  /** One workspace's board as held here. Asking for a board nobody asked
   * for yet starts its load — the answer is `loading` until it lands. */
  board(workspaceId: string): BoardState;
  /** One workspace's board as held here, WITHOUT starting a load — for a
   * render, which must not trigger the notification a load emits. */
  peek(workspaceId: string): BoardState | null;
  /** Settles once the board is loaded, either way. */
  ready(workspaceId: string): Promise<BoardState>;
  subscribe(listener: () => void): () => void;
  /** Bumps on every change to any board — a `useSyncExternalStore` value. */
  revision(): number;
  /** The role addresses on a team right now — what an assignee must be. */
  rosterOf(workspaceId: string, teamId: string): string[];
  create(workspaceId: string, input: CreateTaskInput, actor: TaskActor): Promise<TaskResult>;
  /** Apply `changes` in order, all or nothing: a refusal anywhere leaves
   * the board as it was and writes nothing. */
  apply(
    workspaceId: string,
    taskId: string,
    changes: readonly TaskChange[],
    actor: TaskActor,
  ): Promise<TaskResult>;
  onEvent(listener: (event: TaskEvent) => void): () => void;
  /** Settles once every queued write has been tried AND every board
   * still unsaved has been written once more — what a disable waits for,
   * so a board whose last write failed is not left behind by the store
   * closing under it. A write that fails again stays unsaved. */
  flush(): Promise<void>;
  /** The workspace is gone: drop what is held for it. The disk half is the
   * forgetter's. */
  forget(workspaceId: string): void;
  dispose(): void;
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const states = new Map<string, BoardState>();
  /** One armed retry per workspace whose last write failed. */
  const retries = new Map<string, () => void>();
  const loads = new Map<string, Promise<BoardState>>();
  /** The write chain per workspace — one board after another, in order;
   * each settles to the error it hit, or null. */
  const writes = new Map<string, Promise<string | null>>();
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: TaskEvent) => void>();
  let revision = 0;
  let disposed = false;

  const changed = () => {
    revision += 1;
    for (const listener of [...listeners]) listener();
  };

  const set = (workspaceId: string, state: BoardState) => {
    states.set(workspaceId, state);
    changed();
  };

  const load = (workspaceId: string): Promise<BoardState> => {
    const pending = loads.get(workspaceId);
    if (pending) return pending;
    set(workspaceId, { kind: "loading" });
    const loading = deps.store
      .read({ workspaceId })
      .then((json): BoardState => {
        if (json === null) return { kind: "ready", board: EMPTY_BOARD, unsaved: null };
        const decoded = decodeBoard(json);
        if (decoded.ok) return { kind: "ready", board: decoded.board, unsaved: null };
        const error = decodeFaultText(decoded.fault);
        log.warn("web:tasks", `${workspaceId}: ${error} — the board is read-only until the file is fixed`);
        return { kind: "unreadable", error };
      })
      .catch((e: unknown): BoardState => {
        const error = describeError(e);
        log.warn("web:tasks", `${workspaceId}: reading the board failed: ${error}`);
        return { kind: "unreadable", error };
      })
      .then((state) => {
        // A workspace forgotten (or the owner disposed) while its read was
        // out must not come back as a board.
        if (!disposed && loads.get(workspaceId) === loading) set(workspaceId, state);
        return state;
      });
    loads.set(workspaceId, loading);
    return loading;
  };

  /** Record whether disk and memory agree, when the board is still here. */
  const markUnsaved = (workspaceId: string, error: string | null) => {
    const state = states.get(workspaceId);
    if (state?.kind !== "ready" || state.unsaved === error) return;
    set(workspaceId, { ...state, unsaved: error });
  };

  /**
   * Write one board, after every write queued before it, and say how it
   * went. A failure is not swallowed: the board is marked unsaved for
   * every surface to see, the caller hears it, and a retry is armed —
   * the board in memory is the authority and the disk catches up.
   */
  const persist = (workspaceId: string, board: TaskBoard): Promise<string | null> => {
    const json = encodeBoard(board);
    const previous = writes.get(workspaceId) ?? Promise.resolve(null);
    const next: Promise<string | null> = previous
      .then(() => deps.store.write({ workspaceId, json }))
      .then(
        () => {
          // Only the LATEST write's success means disk and memory agree.
          if (writes.get(workspaceId) === next) markUnsaved(workspaceId, null);
          return null;
        },
        (e: unknown) => {
          const error = describeError(e);
          log.warn("web:tasks", `${workspaceId}: writing the board failed: ${error}`);
          markUnsaved(workspaceId, error);
          armRetry(workspaceId);
          return error;
        },
      );
    writes.set(workspaceId, next);
    return next;
  };

  const armRetry = (workspaceId: string) => {
    if (disposed || retries.has(workspaceId)) return;
    retries.set(
      workspaceId,
      schedule(() => {
        retries.delete(workspaceId);
        const state = states.get(workspaceId);
        if (state?.kind === "ready" && state.unsaved !== null) void persist(workspaceId, state.board);
      }, RETRY_WRITE_MS),
    );
  };

  const emit = (event: TaskEvent) => {
    for (const listener of [...eventListeners]) listener(event);
  };

  /**
   * The board to mutate, read SYNCHRONOUSLY — or the refusal that stands
   * in for it.
   *
   * Every mutation below awaits the load first and then runs from this
   * read to `commit` without yielding. That is the whole concurrency
   * story: an `await` between the two would let a second command read
   * the same board and its commit overwrite the first's — which is
   * exactly what happened while this read sat behind an async helper
   * whose result crossed one more microtask. The write queue orders
   * writes; it cannot un-lose an update decided on a stale board.
   */
  const liveBoard = (
    workspaceId: string,
  ): { ok: true; board: TaskBoard } | { ok: false; refusal: TaskProblem } => {
    const state = states.get(workspaceId);
    if (state?.kind === "unreadable") return { ok: false, refusal: { kind: "board-unreadable", error: state.error } };
    if (state?.kind !== "ready") return { ok: false, refusal: { kind: "board-unreadable", error: "board is not ready" } };
    return { ok: true, board: state.board };
  };

  /** The board decided: held here at once, written after. The unsaved
   * mark carries over until a write lands. */
  const commit = (workspaceId: string, board: TaskBoard): Promise<string | null> => {
    const state = states.get(workspaceId);
    set(workspaceId, { kind: "ready", board, unsaved: state?.kind === "ready" ? state.unsaved : null });
    return persist(workspaceId, board);
  };

  return {
    board(workspaceId) {
      const state = states.get(workspaceId);
      if (state) return state;
      void load(workspaceId);
      return { kind: "loading" };
    },
    peek: (workspaceId) => states.get(workspaceId) ?? null,
    async ready(workspaceId) {
      // The LIVE state once the load has settled — not the load's own
      // answer, which is the board as it was the moment it arrived.
      await load(workspaceId);
      return states.get(workspaceId) ?? { kind: "loading" };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    rosterOf(workspaceId, teamId) {
      const workspace = deps.workspaces().find((candidate) => candidate.id === workspaceId);
      if (!workspace) return [];
      return membersOf(workspace, teamId)
        .map((pane) => pane.team?.role)
        .filter((role): role is string => role !== undefined);
    },
    async create(workspaceId, input, actor) {
      await load(workspaceId);
      // From here to `commit`: no await.
      const held = liveBoard(workspaceId);
      if (!held.ok) return held;
      const result = createTask(input, actor, {
        board: held.board,
        roster: this.rosterOf(workspaceId, input.teamId),
        at: now(),
      });
      if (!result.ok) return result;
      const pending = commit(workspaceId, result.board);
      emit({ kind: "created", workspaceId, task: result.task, actor });
      const saveError = await pending;
      return { ok: true, task: result.task, board: result.board, saved: saveError === null, saveError };
    },
    async apply(workspaceId, taskId, changes, actor) {
      await load(workspaceId);
      // From here to `commit`: no await.
      const held = liveBoard(workspaceId);
      if (!held.ok) return held;
      const before = findTask(held.board, taskId);
      if (!before) return { ok: false, refusal: { kind: "unknown-task", id: taskId } };
      let task = before;
      let board = held.board;
      const at = now();
      const roster = this.rosterOf(workspaceId, before.teamId);
      for (const change of changes) {
        const result = transition(task, change, actor, { board, roster, at });
        if (!result.ok) return result;
        task = result.task;
        board = replaceTask(board, task);
      }
      if (task === before) {
        // Nothing to write — but "saved" is about the BOARD, not this call:
        // after a failed write, repeating a change must not read as the
        // durable success the first attempt was denied.
        await writes.get(workspaceId);
        const state = states.get(workspaceId);
        const saveError = state?.kind === "ready" ? state.unsaved : null;
        return { ok: true, task, board, saved: saveError === null, saveError };
      }
      const pending = commit(workspaceId, board);
      if (task.status !== before.status) {
        if (task.status === "blocked") emit({ kind: "blocked", workspaceId, task, actor });
        if (task.status === "done") emit({ kind: "done", workspaceId, task, actor });
      }
      const saveError = await pending;
      return { ok: true, task, board, saved: saveError === null, saveError };
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async flush() {
      await Promise.all([...writes.values()]);
      // What the queue could not land gets one more try, now — a retry
      // timer would fire into a store that is closing.
      const dirty = [...states.entries()].filter(
        (entry): entry is [string, Extract<BoardState, { kind: "ready" }>] =>
          entry[1].kind === "ready" && entry[1].unsaved !== null,
      );
      await Promise.all(dirty.map(([workspaceId, state]) => persist(workspaceId, state.board)));
    },
    forget(workspaceId) {
      retries.get(workspaceId)?.();
      retries.delete(workspaceId);
      states.delete(workspaceId);
      loads.delete(workspaceId);
      writes.delete(workspaceId);
      changed();
    },
    dispose() {
      disposed = true;
      for (const cancel of retries.values()) cancel();
      retries.clear();
      listeners.clear();
      eventListeners.clear();
    },
  };
}
