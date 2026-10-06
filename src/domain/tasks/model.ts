/**
 * What a task IS — the third system beside mail and artifacts.
 *
 * Mail is a message that lives only in the runtime; an artifact is a shared
 * object; a task is a WORK ORDER: durable, owned by a team, with a status
 * the board shows and an assignee the lead names. Nothing here
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
 * The status ladder. `backlog` is work parked: on the board, not yet to be
 * started — never issuable, so nothing hands it out — until it is moved to
 * `todo`. Parking and unparking are steps of one's own work: the assignee
 * makes them on its own task (as the lead and the user may on any); a
 * parked pool task is unparked by whoever hands out work, since no one
 * holds it. `review` is the assignee saying "finished — look";
 * `done` is the team's lead (or the user) agreeing; `cancelled` is a task
 * that was taken off the board without being done. Both closed states
 * RESOLVE a blocker (see [`blockerResolved`]): a cancelled prerequisite
 * must not hold its dependants hostage forever.
 */
export type TaskStatus = "backlog" | "todo" | "in-progress" | "blocked" | "review" | "done" | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in-progress",
  "blocked",
  "review",
  "done",
  "cancelled",
];

/** The statuses among `values` this build knows, in ladder order, each
 * once — whatever order and repeats they came in. A stored set of
 * statuses (the list's folds) is read, and changed, through it. */
export function inLadderOrder(values: readonly unknown[]): TaskStatus[] {
  return TASK_STATUSES.filter((status) => values.includes(status));
}

/** Three rungs and no numbers: numbers breed arguments about 7 versus 8. */
export type TaskPriority = "high" | "normal" | "low";

export const TASK_PRIORITIES: readonly TaskPriority[] = ["high", "normal", "low"];

export const DEFAULT_PRIORITY: TaskPriority = "normal";

/** What a task is: work, or an epic — a task that groups others under it,
 * one level deep (task-297). Fixed when the task is made; every other
 * fact of an epic — its statuses, its assignee, its blockers — is a
 * task's. */
export type TaskKind = "task" | "epic";

export const TASK_KINDS: readonly TaskKind[] = ["task", "epic"];

/** The fields a change can touch, as the log names them. */
export type TaskField =
  | "status"
  | "assignee"
  | "priority"
  | "title"
  | "body"
  | "blockedBy"
  | "parent"
  | "artifacts"
  | "labels";

/** The same vocabulary as a list — what the codec checks a log entry
 * against and what a command reports as changed. One home. */
export const TASK_FIELDS: readonly TaskField[] = [
  "status",
  "assignee",
  "priority",
  "title",
  "body",
  "blockedBy",
  "parent",
  "artifacts",
  "labels",
];

export interface TaskComment {
  /** Per-task ordinal, minted on append, never reused. */
  n: number;
  at: number;
  /** A role address, or [`USER_NAME`]. */
  from: string;
  body: string;
}

/** What the log names: a field a change touched, a copy's two ends —
 * `copiedFrom` on the copy, `copiedTo` on the task it was copied from
 * (`now` the other task's id) — or a transfer, `transferred` (`was` and
 * `now` the two teams' NAMES: a team id is reused once its team is gone,
 * a name read back is what the board was then). */
export type LogField = TaskField | "copiedFrom" | "copiedTo" | "transferred";

/** Every name a log entry may carry — what the codec checks entries
 * against. */
export const LOG_FIELDS: readonly LogField[] = [...TASK_FIELDS, "copiedFrom", "copiedTo", "transferred"];

/** An earlier version of a task's brief: its number and its text. Who
 * replaced it and when is the log's (`field: "body"`, `was`/`now` the
 * version numbers) — said once, there. */
export interface TaskBrief {
  v: number;
  body: string;
}

/** One change to one field — the audit trail a human reads under a task. */
export interface TaskLogEntry {
  at: number;
  from: string;
  field: LogField;
  was: string | null;
  now: string | null;
}

export interface Task {
  /** The task's own identity: random, global, never changes — what a
   * relation names, so a link survives anything the key does not (a task
   * on another workspace's board, one day; task-224, task-226). Minted by
   * the app and handed in (`CreateContext.mintUid`): the domain draws
   * no random numbers. Never shown to an agent — they address `id`. */
  uid: string;
  /** `task-N` — the KEY people and agents read and write: minted per
   * workspace by [`TaskBoard.nextId`]; never reused, unlike `pane-N` — a
   * cancelled task must not hand its number to the next. */
  id: string;
  /** The team whose board this is on. It changes only by a transfer
   * (`transferTask`) — to another team of the same workspace. */
  teamId: string;
  /** Work or an epic; never changes. */
  kind: TaskKind;
  title: string;
  /** Markdown. Long briefs belong in an artifact named under `artifacts`. */
  body: string;
  /** The number of the brief's current version, from 1. */
  bodyV: number;
  /** The brief's earlier versions, oldest first — every one kept, so a
   * reader can see what it said before each edit. */
  briefs: readonly TaskBrief[];
  status: TaskStatus;
  priority: TaskPriority;
  /** A ROLE address (`impl-1`), never a pane id — roles are addresses and
   * pane slots are reused. `null` = in the team's pool, for anyone to take. */
  assignee: string | null;
  /** Who put it on the board: a role address, or [`USER_NAME`]. */
  author: string;
  /** Artifact ids (slugs) of this workspace. */
  artifacts: readonly string[];
  /** Free words to sort and find tasks by, normalised (`normalizeLabel`)
   * and sorted. The board's vocabulary is whatever its tasks carry
   * (`labelsOf`) — never stored on its own, so nothing to curate. */
  labels: readonly string[];
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
  /** How its tasks are linked — one record per link, never a field on a
   * task (see [`TaskRelation`]). Kept in canonical order
   * (`withRelations`), so saving the same links again is no edit. */
  relations: readonly TaskRelation[];
}

export const EMPTY_BOARD: TaskBoard = { nextId: 1, tasks: [], relations: [] };

/**
 * One link between two tasks: ONE record, both sides read from it — what
 * every tracker with real relations does (research: relations-storage-
 * research). Its ends are task UIDS, so it does not care where either
 * task is shown or what it is called. Stored in one direction per kind
 * (`RelationRule`): `blocks` from the blocker to the task it holds,
 * `copied-from` from the copy to its source, `child-of` from a task to
 * its epic.
 */
export interface TaskRelation {
  /** A [`RelationKind`] this build knows — or a newer build's, kept as
   * read and used by no rule, so an older build is not locked out. */
  kind: string;
  from: string;
  to: string;
  at: number;
  /** Who made the link; null when that is not known — a blocker carried
   * over from a board written before relations, or an actor with no name. */
  by: string | null;
}

/** The kinds of link this build knows. */
export type RelationKind = "blocks" | "copied-from" | "child-of";

/** What a kind of link IS — the one place each rule about it lives: the
 * gate, the transfer, the board's housekeeping and the codec read these
 * columns and state none of them again. A new kind is a new row (and a
 * new column only when a rule reads it). Who makes each is its writers':
 * `blocks` from the blockers a task is created with (any member may
 * create one waiting on its team's tasks), a duplicate's carried-over
 * open blockers, and the `blockedBy` change, which only whoever hands out
 * work may make; `copied-from` by the duplicate alone — no change takes
 * one away; `child-of` by the epic a task is created in, and the `parent`
 * change, which only whoever hands out work may make. */
export interface RelationRule {
  /** Whether its `from` end, while open, holds its `to` end off the
   * ladder's start (`issuable`, the start edges). */
  gatesStart: boolean;
  /** At most one per `from` — a copy has one source. */
  onePerFrom: boolean;
  /** Whether it stays when its `to` end leaves the board (a disbanded
   * team's tasks go): a copy still came from its source, which reads as
   * gone; a blocker that held something holds nothing now. Its `from`
   * leaving takes any link with it — the copy itself is gone. */
  outlivesItsTo: boolean;
  /** What each end must be, or null when any task may stand at either:
   * a task's epic is an epic, and the task under it is work — so an epic
   * has no epic, and the family is one level deep by construction. */
  ends: { from: TaskKind; to: TaskKind } | null;
  /** Whether its `from` comes before its `to` — a blocker before what it
   * holds, a task before its epic's close: the order every "would this
   * close a loop?" walks, so no two tasks can each wait on the other. */
  ordersEnds: boolean;
}

export const RELATION_KINDS: Readonly<Record<RelationKind, RelationRule>> = {
  blocks: { gatesStart: true, onePerFrom: false, outlivesItsTo: false, ends: null, ordersEnds: true },
  "copied-from": { gatesStart: false, onePerFrom: true, outlivesItsTo: true, ends: null, ordersEnds: false },
  // A task has one epic; a task under an epic that left the board is
  // under none. An epic closes only after its tasks: the task comes first.
  "child-of": { gatesStart: false, onePerFrom: true, outlivesItsTo: false, ends: { from: "task", to: "epic" }, ordersEnds: true },
};

/** Whether this build knows `kind` — the rest are carried, not read. */
export function isRelationKind(kind: string): kind is RelationKind {
  return Object.prototype.hasOwnProperty.call(RELATION_KINDS, kind);
}

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

/** Bounds on what one field holds — a FORMAT, enforced HERE and nowhere
 * else: the store persists what the domain accepted, so a second copy of
 * these numbers in Rust would be the drift the design rules forbid. How
 * MUCH a board holds is not bounded: every comment, every log entry and
 * every task is kept (the user's decision, task-221 — the database keeps
 * everything, and what an agent is shown is the command layer's to size). */
export const TASK_CAPS = {
  titleMax: 120,
  bodyMax: 8192,
  commentMax: 4000,
  /** Labels on one task — a few words, not a taxonomy. */
  labelsMax: 5,
  labelMax: 24,
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

/** Whether `value` has the shape of a task uid — what the app mints (a
 * UUID) and anything like it: letters, digits and dashes, bounded. */
export function isTaskUid(value: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(value);
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskKind(value: string): value is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}
