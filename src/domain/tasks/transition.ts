/**
 * Every way a task changes, and who may change it — one table, asked by
 * the MCP commands and the dialog alike. The command layer renders a
 * refusal into prose; nothing here writes English.
 *
 * Authority mirrors mail's: the actor's [`RoleStanding`] decides. A role
 * that LEADS (or a peer on a flat team) hands work out and accepts it; a
 * role that REPORTS moves only its own task along the ladder; the user
 * outranks everyone and walks no ladder at all — any status, any time.
 * A prohibition binds the act, never the channel.
 */
import { openBlockersOf, findTask } from "./board";
import {
  DEFAULT_PRIORITY,
  TASK_CAPS,
  TASK_STATUSES,
  acceptsWork,
  actorName,
  type Task,
  type TaskActor,
  type TaskBoard,
  type TaskField,
  type TaskLogEntry,
  type TaskPriority,
  type TaskStatus,
} from "./model";

export type TaskChange =
  /** Take a pool task for yourself, without starting it. */
  | { kind: "claim" }
  | { kind: "assign"; assignee: string | null }
  | { kind: "status"; to: TaskStatus }
  | { kind: "priority"; to: TaskPriority }
  | { kind: "title"; to: string }
  | { kind: "body"; to: string }
  | { kind: "blockedBy"; to: readonly string[] }
  | { kind: "artifacts"; to: readonly string[] }
  | { kind: "comment"; body: string };

/** Why a change was refused — data, so the rendering stays with the
 * surface that speaks to the caller. */
export type TaskRefusal =
  /** The agent stands on no team, or holds no role the deck can name. */
  | { kind: "not-an-agent-on-a-team" }
  /** The agent's team is not the task's team. */
  | { kind: "not-on-team" }
  /** A working role moving a task that is somebody else's. */
  | { kind: "not-your-task"; assignee: string | null }
  /** A working role editing what only the lead sets. */
  | { kind: "not-yours-to-assign"; field: TaskField }
  /** A working role accepting, returning, reopening or cancelling. */
  | { kind: "review-not-yours" }
  | {
      kind: "illegal-transition";
      from: TaskStatus;
      to: TaskStatus;
      /** Where this actor MAY move the task from `from` — set on a status
       * move, so a refusal teaches the ladder instead of leaving the
       * caller to find it by trial. Absent for a claim, which is no move. */
      reachable?: readonly TaskStatus[];
    }
  | { kind: "blocked-by-open"; blockers: readonly string[] }
  | { kind: "already-claimed"; assignee: string }
  | { kind: "claim-needs-an-agent" }
  | { kind: "assignee-not-on-team"; assignee: string }
  | { kind: "unknown-blocker"; ids: readonly string[] }
  | { kind: "cross-team-blocker"; ids: readonly string[] }
  | { kind: "self-blocker" }
  | { kind: "cyclic-blocker"; ids: readonly string[] }
  | { kind: "field-cap"; field: "title" | "body" | "comment"; max: number }
  | { kind: "blank"; field: "title" | "comment" }
  | { kind: "board-full"; max: number }
  /** The id counter cannot mint another safe integer. Unreachable by
   * honest use; refused rather than overflowed. */
  | { kind: "counter-exhausted" };

export interface TransitionContext {
  board: TaskBoard;
  /** The role addresses on the task's team — what an assignee must be. */
  roster: readonly string[];
  at: number;
}

export type TransitionResult =
  | { ok: true; task: Task }
  | { ok: false; refusal: TaskRefusal };

type Refused = { ok: false; refusal: TaskRefusal };

const refuse = (refusal: TaskRefusal): Refused => ({ ok: false, refusal });

/** Whether this actor hands out work: the user, or a role that accepts it. */
export function mayAssign(actor: TaskActor): boolean {
  return actor.kind === "user" || acceptsWork(actor.standing);
}

/** The user, or an agent standing on `teamId` under a role. */
function onTeam(actor: TaskActor, teamId: string): TaskRefusal | null {
  if (actor.kind === "user") return null;
  if (actor.role === null || actor.teamId === null) return { kind: "not-an-agent-on-a-team" };
  if (actor.teamId !== teamId) return { kind: "not-on-team" };
  return null;
}

/**
 * The ladder's edges. `worker` edges are the assignee's to make (and the
 * lead's, and the user's); `acceptor` edges belong to whoever hands out
 * work. A start needs every blocker resolved — the one rule `issuable`
 * also reads, asked here of the SAME blockers.
 */
const EDGES: readonly {
  from: TaskStatus;
  to: TaskStatus;
  who: "worker" | "acceptor";
  needsBlockersResolved?: true;
}[] = [
  { from: "todo", to: "in-progress", who: "worker", needsBlockersResolved: true },
  { from: "in-progress", to: "blocked", who: "worker" },
  { from: "blocked", to: "in-progress", who: "worker", needsBlockersResolved: true },
  { from: "in-progress", to: "review", who: "worker" },
  { from: "review", to: "done", who: "acceptor" },
  { from: "review", to: "in-progress", who: "acceptor" },
  { from: "done", to: "todo", who: "acceptor" },
  { from: "cancelled", to: "todo", who: "acceptor" },
  { from: "todo", to: "cancelled", who: "acceptor" },
  { from: "in-progress", to: "cancelled", who: "acceptor" },
  { from: "blocked", to: "cancelled", who: "acceptor" },
  { from: "review", to: "cancelled", who: "acceptor" },
];

function joined(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(",");
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
}

/** What is wrong with a title, or nothing — the rule the transition and
 * the create apply, and the one a form asks before offering to submit. */
export function titleProblem(title: string): TaskRefusal | null {
  return validateTitle(title);
}

/** What is wrong with a comment, or nothing — same rule as the comment
 * change applies. */
export function commentProblem(body: string): TaskRefusal | null {
  const trimmed = body.trim();
  if (trimmed === "") return { kind: "blank", field: "comment" };
  if (trimmed.length > TASK_CAPS.commentMax) {
    return { kind: "field-cap", field: "comment", max: TASK_CAPS.commentMax };
  }
  return null;
}

function validateTitle(title: string): TaskRefusal | null {
  if (title.trim() === "") return { kind: "blank", field: "title" };
  if (title.length > TASK_CAPS.titleMax) {
    return { kind: "field-cap", field: "title", max: TASK_CAPS.titleMax };
  }
  return null;
}

function validateBody(body: string): TaskRefusal | null {
  return body.length > TASK_CAPS.bodyMax
    ? { kind: "field-cap", field: "body", max: TASK_CAPS.bodyMax }
    : null;
}

function validateAssignee(
  assignee: string | null,
  roster: readonly string[],
): TaskRefusal | null {
  return assignee === null || roster.includes(assignee)
    ? null
    : { kind: "assignee-not-on-team", assignee };
}

/**
 * Blockers must name tasks of the same team that exist, are not the task
 * itself, and do not lead back to it — a cycle is a deadlock the board
 * would never surface as anything but "nothing is issuable".
 */
function validateBlockers(
  taskId: string | null,
  teamId: string,
  ids: readonly string[],
  board: TaskBoard,
): TaskRefusal | null {
  if (taskId !== null && ids.includes(taskId)) return { kind: "self-blocker" };
  const unknown = ids.filter((id) => findTask(board, id) === undefined);
  if (unknown.length > 0) return { kind: "unknown-blocker", ids: unknown };
  const foreign = ids.filter((id) => findTask(board, id)?.teamId !== teamId);
  if (foreign.length > 0) return { kind: "cross-team-blocker", ids: foreign };
  if (taskId !== null) {
    const cyclic = ids.filter((id) => reaches(board, id, taskId, new Set()));
    if (cyclic.length > 0) return { kind: "cyclic-blocker", ids: cyclic };
  }
  return null;
}

/** Whether following `blockedBy` from `fromId` ever arrives at `target`. */
function reaches(board: TaskBoard, fromId: string, target: string, seen: Set<string>): boolean {
  if (fromId === target) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const from = findTask(board, fromId);
  return from !== undefined && from.blockedBy.some((next) => reaches(board, next, target, seen));
}

function logged(
  task: Task,
  entries: readonly TaskLogEntry[],
  at: number,
  patch: Partial<Task>,
): Task {
  const log = [...task.log, ...entries].slice(-TASK_CAPS.logMax);
  return { ...task, ...patch, log, updated: at };
}

/** Apply one change to one task, or say why not. */
export function transition(
  task: Task,
  change: TaskChange,
  actor: TaskActor,
  ctx: TransitionContext,
): TransitionResult {
  const membership = onTeam(actor, task.teamId);
  if (membership) return refuse(membership);
  const by = actorName(actor) ?? "";
  const { at } = ctx;
  switch (change.kind) {
    case "claim": {
      if (actor.kind !== "agent" || actor.role === null) {
        return refuse({ kind: "claim-needs-an-agent" });
      }
      if (task.assignee === actor.role) return { ok: true, task };
      if (task.assignee !== null) {
        return refuse({ kind: "already-claimed", assignee: task.assignee });
      }
      if (task.status !== "todo") {
        return refuse({ kind: "illegal-transition", from: task.status, to: "in-progress" });
      }
      const open = openBlockersOf(task, ctx.board);
      if (open.length > 0) return refuse({ kind: "blocked-by-open", blockers: open });
      return {
        ok: true,
        task: logged(task, [{ at, from: by, field: "assignee", was: null, now: actor.role }], at, {
          assignee: actor.role,
        }),
      };
    }
    case "assign": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "assignee" });
      const bad = validateAssignee(change.assignee, ctx.roster);
      if (bad) return refuse(bad);
      if (change.assignee === task.assignee) return { ok: true, task };
      return {
        ok: true,
        task: logged(
          task,
          [{ at, from: by, field: "assignee", was: task.assignee, now: change.assignee }],
          at,
          { assignee: change.assignee },
        ),
      };
    }
    case "status": {
      const moved = moveStatus(task, change.to, actor, ctx, by);
      if (moved.ok || moved.refusal.kind !== "illegal-transition") return moved;
      return refuse({ ...moved.refusal, reachable: reachableStatuses(task, actor, ctx) });
    }
    case "priority": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "priority" });
      if (change.to === task.priority) return { ok: true, task };
      return {
        ok: true,
        task: logged(
          task,
          [{ at, from: by, field: "priority", was: task.priority, now: change.to }],
          at,
          { priority: change.to },
        ),
      };
    }
    case "title": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "title" });
      const bad = validateTitle(change.to);
      if (bad) return refuse(bad);
      const title = change.to.trim();
      if (title === task.title) return { ok: true, task };
      return {
        ok: true,
        task: logged(task, [{ at, from: by, field: "title", was: task.title, now: title }], at, {
          title,
        }),
      };
    }
    case "body": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "body" });
      const bad = validateBody(change.to);
      if (bad) return refuse(bad);
      if (change.to === task.body) return { ok: true, task };
      // The PREVIOUS brief goes to the log, whole, and the new one is on
      // the task: every version is kept exactly once, and a reviewer can
      // read what the brief said before each edit. `now` is null because
      // the current text is never a copy.
      return {
        ok: true,
        task: logged(task, [{ at, from: by, field: "body", was: task.body, now: null }], at, {
          body: change.to,
        }),
      };
    }
    case "blockedBy": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "blockedBy" });
      const ids = normalizeIds(change.to);
      const bad = validateBlockers(task.id, task.teamId, ids, ctx.board);
      if (bad) return refuse(bad);
      if (joined(ids) === joined(task.blockedBy)) return { ok: true, task };
      return {
        ok: true,
        task: logged(
          task,
          [{ at, from: by, field: "blockedBy", was: joined(task.blockedBy), now: joined(ids) }],
          at,
          { blockedBy: ids },
        ),
      };
    }
    case "artifacts": {
      // Any member attaches: the assignee's report belongs on its task.
      const ids = normalizeIds(change.to);
      if (joined(ids) === joined(task.artifacts)) return { ok: true, task };
      return {
        ok: true,
        task: logged(
          task,
          [{ at, from: by, field: "artifacts", was: joined(task.artifacts), now: joined(ids) }],
          at,
          { artifacts: ids },
        ),
      };
    }
    case "comment": {
      const problem = commentProblem(change.body);
      if (problem) return refuse(problem);
      const body = change.body.trim();
      // Ordinals never repeat, even after the oldest fell off.
      const n = task.comments.reduce((top, c) => Math.max(top, c.n), 0) + 1;
      const comments = [...task.comments, { n, at, from: by, body }].slice(
        -TASK_CAPS.commentsMax,
      );
      return { ok: true, task: { ...task, comments, updated: at } };
    }
  }
}

function moveStatus(
  task: Task,
  to: TaskStatus,
  actor: TaskActor,
  ctx: TransitionContext,
  by: string,
): TransitionResult {
  if (to === task.status) return { ok: true, task };
  // The PERSON is not on the ladder: they move a task anywhere, blockers
  // notwithstanding — the board is theirs to correct, and a rule that
  // refused them would be a rule about the agents applied to their user.
  if (actor.kind === "user") {
    return {
      ok: true,
      task: logged(task, [{ at: ctx.at, from: by, field: "status", was: task.status, now: to }], ctx.at, {
        status: to,
      }),
    };
  }
  const edge = EDGES.find((e) => e.from === task.status && e.to === to);
  if (!edge) return refuse({ kind: "illegal-transition", from: task.status, to });
  const entries: TaskLogEntry[] = [];
  let assignee = task.assignee;
  if (edge.who === "acceptor") {
    if (!mayAssign(actor)) return refuse({ kind: "review-not-yours" });
  } else if (!mayAssign(actor)) {
    // A working role: its own task, or a pool task it takes by starting.
    const role = actor.kind === "agent" ? actor.role : null;
    if (task.assignee !== role) {
      if (task.assignee !== null || task.status !== "todo") {
        return refuse({ kind: "not-your-task", assignee: task.assignee });
      }
      assignee = role;
      entries.push({ at: ctx.at, from: by, field: "assignee", was: null, now: role });
    }
  }
  if (edge.needsBlockersResolved) {
    const open = openBlockersOf(task, ctx.board);
    if (open.length > 0) return refuse({ kind: "blocked-by-open", blockers: open });
  }
  entries.push({ at: ctx.at, from: by, field: "status", was: task.status, now: to });
  return { ok: true, task: logged(task, entries, ctx.at, { status: to, assignee }) };
}

/**
 * The statuses `actor` may move `task` to from where it stands, in ladder
 * order — the picker's options and the board's drop targets, asked of the
 * same table so the two can never disagree.
 */
export function reachableStatuses(task: Task, actor: TaskActor, ctx: TransitionContext): TaskStatus[] {
  // `transition` less its refusal wording: the membership check, then the
  // move itself — asked of `moveStatus` directly, because `transition`
  // asks HERE to word an illegal move.
  if (onTeam(actor, task.teamId)) return [];
  const by = actorName(actor) ?? "";
  return TASK_STATUSES.filter(
    (to) => to !== task.status && moveStatus(task, to, actor, ctx, by).ok,
  );
}

export interface CreateTaskInput {
  teamId: string;
  title: string;
  body?: string;
  assignee?: string | null;
  priority?: TaskPriority;
  blockedBy?: readonly string[];
  artifacts?: readonly string[];
}

export type CreateResult =
  | { ok: true; board: TaskBoard; task: Task }
  | { ok: false; refusal: TaskRefusal };

/**
 * Put a task on the board. A working role may create for itself or for
 * the pool, at the default priority — what to do next is its to say, whom
 * it goes to and how urgently is the lead's.
 */
export function createTask(
  input: CreateTaskInput,
  actor: TaskActor,
  ctx: TransitionContext,
): CreateResult {
  const membership = onTeam(actor, input.teamId);
  if (membership) return refuse(membership);
  if (ctx.board.tasks.length >= TASK_CAPS.tasksMax) {
    return refuse({ kind: "board-full", max: TASK_CAPS.tasksMax });
  }
  if (!Number.isSafeInteger(ctx.board.nextId + 1)) return refuse({ kind: "counter-exhausted" });
  const badTitle = validateTitle(input.title);
  if (badTitle) return refuse(badTitle);
  const body = input.body ?? "";
  const badBody = validateBody(body);
  if (badBody) return refuse(badBody);
  const assignee = input.assignee ?? null;
  const priority = input.priority ?? DEFAULT_PRIORITY;
  if (!mayAssign(actor)) {
    const own = actor.kind === "agent" ? actor.role : null;
    if (assignee !== null && assignee !== own) {
      return refuse({ kind: "not-yours-to-assign", field: "assignee" });
    }
    if (priority !== DEFAULT_PRIORITY) {
      return refuse({ kind: "not-yours-to-assign", field: "priority" });
    }
  }
  const badAssignee = validateAssignee(assignee, ctx.roster);
  if (badAssignee) return refuse(badAssignee);
  const blockedBy = normalizeIds(input.blockedBy ?? []);
  const badBlockers = validateBlockers(null, input.teamId, blockedBy, ctx.board);
  if (badBlockers) return refuse(badBlockers);
  const task: Task = {
    id: `task-${ctx.board.nextId}`,
    teamId: input.teamId,
    title: input.title.trim(),
    body,
    status: "todo",
    priority,
    assignee,
    author: actorName(actor) ?? "",
    blockedBy,
    artifacts: normalizeIds(input.artifacts ?? []),
    comments: [],
    log: [],
    created: ctx.at,
    updated: ctx.at,
  };
  return {
    ok: true,
    task,
    board: { nextId: ctx.board.nextId + 1, tasks: [...ctx.board.tasks, task] },
  };
}

/** The board with `task` in place of the one that shares its id. */
export function replaceTask(board: TaskBoard, task: Task): TaskBoard {
  return {
    nextId: board.nextId,
    tasks: board.tasks.map((existing) => (existing.id === task.id ? task : existing)),
  };
}
