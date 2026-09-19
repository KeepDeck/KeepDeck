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
}

export type BoardState =
  | { kind: "loading" }
  | { kind: "ready"; board: TaskBoard }
  /** The file did not decode; its words, verbatim. Read-only until fixed. */
  | { kind: "unreadable"; error: string };

/** Why a command could not act — the domain's refusals plus the two only
 * this owner can raise. */
export type TaskProblem =
  | TaskRefusal
  | { kind: "board-unreadable"; error: string }
  | { kind: "unknown-task"; id: string };

export type TaskResult =
  | { ok: true; task: Task; board: TaskBoard }
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
  /** The workspace is gone: drop what is held for it. The disk half is the
   * forgetter's. */
  forget(workspaceId: string): void;
  dispose(): void;
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const now = deps.now ?? (() => Date.now());
  const states = new Map<string, BoardState>();
  const loads = new Map<string, Promise<BoardState>>();
  /** The write chain per workspace — one board after another, in order. */
  const writes = new Map<string, Promise<void>>();
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
        if (json === null) return { kind: "ready", board: EMPTY_BOARD };
        const decoded = decodeBoard(json);
        if (decoded.ok) return { kind: "ready", board: decoded.board };
        log.warn("web:tasks", `${workspaceId}: ${decoded.error} — the board is read-only until the file is fixed`);
        return { kind: "unreadable", error: decoded.error };
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

  const persist = (workspaceId: string, board: TaskBoard) => {
    const json = encodeBoard(board);
    const previous = writes.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .then(() => deps.store.write({ workspaceId, json }))
      .catch((e: unknown) => {
        // The board in memory stands; the next change writes it again.
        log.warn("web:tasks", `${workspaceId}: writing the board failed: ${describeError(e)}`);
      });
    writes.set(workspaceId, next);
  };

  const emit = (event: TaskEvent) => {
    for (const listener of [...eventListeners]) listener(event);
  };

  /** The board to mutate, or the refusal that stands in for it. */
  const boardFor = async (
    workspaceId: string,
  ): Promise<{ ok: true; board: TaskBoard } | { ok: false; refusal: TaskProblem }> => {
    const state = await load(workspaceId);
    if (state.kind === "unreadable") return { ok: false, refusal: { kind: "board-unreadable", error: state.error } };
    // Read the LIVE board after the await, not the one the load answered
    // with: another command may have moved it in between.
    const live = states.get(workspaceId);
    if (live?.kind !== "ready") return { ok: false, refusal: { kind: "board-unreadable", error: "board is not ready" } };
    return { ok: true, board: live.board };
  };

  const commit = (workspaceId: string, board: TaskBoard) => {
    set(workspaceId, { kind: "ready", board });
    persist(workspaceId, board);
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
      const held = await boardFor(workspaceId);
      if (!held.ok) return held;
      const result = createTask(input, actor, {
        board: held.board,
        roster: this.rosterOf(workspaceId, input.teamId),
        at: now(),
      });
      if (!result.ok) return result;
      commit(workspaceId, result.board);
      emit({ kind: "created", workspaceId, task: result.task, actor });
      return { ok: true, task: result.task, board: result.board };
    },
    async apply(workspaceId, taskId, changes, actor) {
      const held = await boardFor(workspaceId);
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
      if (task === before) return { ok: true, task, board };
      commit(workspaceId, board);
      if (task.status !== before.status) {
        if (task.status === "blocked") emit({ kind: "blocked", workspaceId, task, actor });
        if (task.status === "done") emit({ kind: "done", workspaceId, task, actor });
      }
      return { ok: true, task, board };
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    forget(workspaceId) {
      states.delete(workspaceId);
      loads.delete(workspaceId);
      writes.delete(workspaceId);
      changed();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      eventListeners.clear();
    },
  };
}
