/**
 * What a task IS — the third system beside mail and artifacts.
 *
 * Mail is a message that lives only in the runtime; an artifact is a shared
 * object; a task is a WORK ORDER: durable, owned by a team, with a status
 * the board shows and an assignee `task.next` and `task.mine` read by. Nothing here
 * reaches an agent on its own — the board is a record, and telling an
 * agent about its work is a letter somebody chooses to send (the user's
 * decision, 2026-09-19). So the model carries no delivery state at all: no
 * cursor, no "seen", no wake.
 *
 * Pure data and pure rules, no deck, no store, no React — the shape
 * `src/domain/mail` set. The store persists a [`TaskBoard`] verbatim; the
 * command layer renders refusals into prose; neither repeats a rule.
 */
import { parseRoleAddress, type RoleStanding } from "../mail/roles";

/**
 * The status ladder. `review` is the assignee saying "finished — look";
 * `done` is the team's lead (or the user) agreeing; `cancelled` is a task
 * that was taken off the board without being done. Both closed states
 * RESOLVE a blocker (see [`blockerResolved`]): a cancelled prerequisite
 * must not hold its dependants hostage forever.
 */
export type TaskStatus = "todo" | "in-progress" | "blocked" | "review" | "done" | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "in-progress",
  "blocked",
  "review",
  "done",
  "cancelled",
];

/** Three rungs and no numbers: numbers breed arguments about 7 versus 8. */
export type TaskPriority = "high" | "normal" | "low";

export const TASK_PRIORITIES: readonly TaskPriority[] = ["high", "normal", "low"];

export const DEFAULT_PRIORITY: TaskPriority = "normal";

/** The fields a change can touch, as the log names them. */
export type TaskField =
  | "status"
  | "assignee"
  | "priority"
  | "title"
  | "body"
  | "blockedBy"
  | "artifacts";

/** The same vocabulary as a list — what the codec checks a log entry
 * against and what a command reports as changed. One home. */
export const TASK_FIELDS: readonly TaskField[] = [
  "status",
  "assignee",
  "priority",
  "title",
  "body",
  "blockedBy",
  "artifacts",
];

export interface TaskComment {
  /** Per-task ordinal, minted on append, never reused. */
  n: number;
  at: number;
  /** A role address, or [`USER_NAME`]. */
  from: string;
  body: string;
}

/** One change to one field — the audit trail a human reads under a task. */
export interface TaskLogEntry {
  at: number;
  from: string;
  field: TaskField;
  was: string | null;
  now: string | null;
}

export interface Task {
  /** `task-N`, minted per workspace by [`TaskBoard.nextId`]; never reused,
   * unlike `pane-N` — a cancelled task must not hand its number to the next. */
  id: string;
  /** The team whose board this is on. A task never moves between teams. */
  teamId: string;
  title: string;
  /** Markdown. Long briefs belong in an artifact named under `artifacts`. */
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** A ROLE address (`impl-1`), never a pane id — roles are addresses and
   * pane slots are reused. `null` = in the team's pool, for anyone to take. */
  assignee: string | null;
  /** Who put it on the board: a role address, or [`USER_NAME`]. */
  author: string;
  /** Tasks of the same workspace that must resolve first. */
  blockedBy: readonly string[];
  /** Artifact ids (slugs) of this workspace. */
  artifacts: readonly string[];
  comments: readonly TaskComment[];
  log: readonly TaskLogEntry[];
  created: number;
  updated: number;
}

/** One workspace's board — what the store keeps as `board.json`. */
export interface TaskBoard {
  /** The next `task-N` to mint. Persisted, so a restart cannot reuse a
   * number a cancelled task gave up. */
  nextId: number;
  tasks: readonly Task[];
}

export const EMPTY_BOARD: TaskBoard = { nextId: 1, tasks: [] };

/** How the deck names the person in `author`, `from` and the log. The UI
 * renders it as "you"; the domain stores this one word. */
export const USER_NAME = "user";

/**
 * Who is acting. The user acts from the app and outranks everyone; an agent
 * acts from a pane and stands where its role stands (the same
 * [`RoleStanding`] mail reads — no second hierarchy). `standing` is null for
 * a role the catalog cannot place, `teamId` null for a pane on no team.
 */
export type TaskActor =
  | { kind: "user" }
  | {
      kind: "agent";
      role: string | null;
      standing: RoleStanding | null;
      teamId: string | null;
    };

export const USER_ACTOR: TaskActor = { kind: "user" };

/** The actor an agent pane is, from what the deck knows about it. */
export function agentActor(
  role: string | undefined,
  teamId: string | undefined,
): TaskActor {
  return {
    kind: "agent",
    role: role ?? null,
    standing: role === undefined ? null : (parseRoleAddress(role)?.role.standing ?? null),
    teamId: teamId ?? null,
  };
}

/** Whether a role of this standing hands out work and accepts it — the
 * lead, or a peer on a flat team. The ONE answer to that question: the
 * transition table asks it for assigning and accepting, the board asks it
 * for whose plate the team's review is on. */
export function acceptsWork(standing: RoleStanding | null): boolean {
  return standing === "leads" || standing === "peer";
}

/** The name an actor signs with in `author`, comments and the log. */
export function actorName(actor: TaskActor): string | null {
  return actor.kind === "user" ? USER_NAME : actor.role;
}

/** Bounds on what the board stores. Enforced HERE and nowhere else: the
 * store persists what the domain accepted, so a second copy of these
 * numbers in Rust would be the drift the design rules forbid. */
export const TASK_CAPS = {
  titleMax: 120,
  bodyMax: 8192,
  commentMax: 4000,
  /** Oldest comments fall off past this; the log still records them. */
  commentsMax: 200,
  /** Oldest log entries fall off past this. */
  logMax: 500,
  /** Creating past this is refused, never silently cancelled. */
  tasksMax: 2000,
} as const;

/** Whether a task is still on the board's live half. */
export function isOpen(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

/** Whether a task in this status no longer holds its dependants. */
export function blockerResolved(status: TaskStatus): boolean {
  return !isOpen(status);
}

/** Whether `value` has the shape of a task id — the minting rule, asserted
 * rather than guessed, so a caller that passed a role or prose is told what
 * it did rather than told its task does not exist. */
export function isTaskId(value: string): boolean {
  return /^task-\d+$/.test(value);
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}
