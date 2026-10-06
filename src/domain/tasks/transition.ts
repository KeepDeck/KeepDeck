/**
 * Every way a task changes, and who may change it — one table, asked by
 * the MCP commands and the dialog alike. The command layer renders a
 * refusal into prose; nothing here writes English.
 *
 * Authority mirrors mail's: the actor's [`RoleStanding`] decides. A role
 * that LEADS (or a peer on a flat team) hands work out and accepts it; a
 * role that REPORTS moves only its own task along the ladder; the user
 * outranks everyone and walks no ladder at all — any status, any time,
 * but for the one rule of an epic's family (`epicMoveProblem`).
 * A prohibition binds the act, never the channel.
 */
import {
  DEFAULT_PRIORITY,
  TASK_CAPS,
  TASK_STATUSES,
  RELATION_KINDS,
  TASK_KINDS,
  acceptsWork,
  actorName,
  isOpen,
  type Task,
  type TaskActor,
  type TaskBoard,
  type TaskField,
  type TaskKind,
  type TaskLogEntry,
  type TaskPriority,
  type TaskStatus,
} from "./model";
import {
  blockerIdsOf,
  epicOf,
  findTask,
  linked,
  openBlockersOf,
  replaceTask,
  setBlockers,
  setEpic,
  unblocks,
  withoutGates,
  transitiveBlockers,
  transitiveWaiters,
  withTasks,
} from "./relations";
import { openWorkUnder, tasksOfTeam } from "./board";

export type TaskChange =
  /** Take a pool task for yourself, without starting it. */
  | { kind: "claim" }
  | { kind: "assign"; assignee: string | null }
  | { kind: "status"; to: TaskStatus }
  | { kind: "priority"; to: TaskPriority }
  | { kind: "title"; to: string }
  | { kind: "body"; to: string }
  | { kind: "blockedBy"; to: readonly string[] }
  /** The epic the task is under (its key), or none. */
  | { kind: "parent"; to: string | null }
  /** One blocker on, or off — applied to the blockers as they stand when
   * the change lands, so one an agent set meanwhile stays. */
  | { kind: "addBlocker"; id: string }
  | { kind: "removeBlocker"; id: string }
  | { kind: "artifacts"; to: readonly string[] }
  /** The whole set, replacing what is there. */
  | { kind: "labels"; to: readonly string[] }
  /** One label on, or off — applied to the task as it stands when the
   * change lands, so a label put on by someone else meanwhile stays. */
  | { kind: "addLabel"; label: string }
  | { kind: "removeLabel"; label: string }
  | { kind: "comment"; body: string };

/** The change that attaches `slug` to `task`. A slug already there is
 * the transition's to fold: it normalizes every artifacts list, once. */
export function attachArtifact(task: Pick<Task, "artifacts">, slug: string): TaskChange {
  return { kind: "artifacts", to: [...task.artifacts, slug] };
}

/** The change that takes `slug` off `task`'s attachments. */
export function detachArtifact(task: Pick<Task, "artifacts">, slug: string): TaskChange {
  return { kind: "artifacts", to: task.artifacts.filter((other) => other !== slug) };
}

/** The change that makes a task wait on `id` as well. */
export function addBlocker(id: string): TaskChange {
  return { kind: "addBlocker", id };
}

/** The change that lets a task stop waiting on `id`. */
export function removeBlocker(id: string): TaskChange {
  return { kind: "removeBlocker", id };
}

/** The change that puts `label` on a task. Normalising it, and folding a
 * label already there, is the transition's — one rule, applied once. */
export function addLabel(label: string): TaskChange {
  return { kind: "addLabel", label };
}

/** The change that takes `label` off a task. */
export function removeLabel(label: string): TaskChange {
  return { kind: "removeLabel", label };
}

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
  /** A working role making a move that is whoever hands out work's:
   * accepting, reopening, cancelling, or moving a task off its ladder. */
  | { kind: "not-yours-to-move" }
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
  /** An epic named that the board does not hold, or a task named as one
   * that is work. */
  | { kind: "unknown-epic"; id: string }
  | { kind: "not-an-epic"; id: string }
  /** An epic put under an epic: the family is one level deep. */
  | { kind: "epic-under-epic" }
  | { kind: "cross-team-epic"; id: string }
  /** Open work entering an epic that is closed — created in it, put under
   * it, or reopened under it. The epic is reopened first. */
  | { kind: "closed-epic"; id: string }
  /** An epic closed while work under it is open: each, where it stands —
   * nothing is closed for it, nobody is held to less (the person too). */
  | { kind: "epic-has-open-work"; open: readonly { id: string; status: TaskStatus }[] }
  /** A task asked to be made as something that is neither work nor an epic. */
  | { kind: "bad-create-kind"; value: string; allowed: readonly TaskKind[] }
  /** A field past its cap: which, how long it is, how long it may be —
   * measured as it would be KEPT (a title and a comment trimmed). */
  | { kind: "field-cap"; field: "title" | "body" | "comment"; max: number; length: number }
  /** A transfer that cannot be made: of a closed task, to its own team,
   * by an actor who does not hand out work, or of a task still linked by
   * blockers to its team (`blockers` it waits on, `dependants` waiting on
   * it — cross-team links are not allowed). */
  | { kind: "transfer-closed"; status: TaskStatus }
  | { kind: "transfer-same-team" }
  | { kind: "not-yours-to-transfer" }
  | { kind: "transfer-linked"; blockers: readonly string[]; dependants: readonly string[] }
  /** A task asked to start anywhere but where a task may be created. */
  | { kind: "bad-create-status"; status: string; allowed: readonly TaskStatus[] }
  /** A label that is not a word: empty, too long, or with a character
   * outside lowercase letters, digits and inner dashes. */
  | { kind: "bad-label"; label: string; max: number }
  | { kind: "too-many-labels"; max: number }
  /** A working role labelling a task that is not its own. */
  | { kind: "not-yours-to-label"; assignee: string | null }
  | { kind: "blank"; field: "title" | "comment" }
  /** The id counter cannot mint another safe integer. Unreachable by
   * honest use; refused rather than overflowed. */
  | { kind: "counter-exhausted" };

export interface TransitionContext {
  board: TaskBoard;
  /** The role addresses on the task's team — what an assignee must be. */
  roster: readonly string[];
  at: number;
}

/** What a write that MAKES a task needs besides: a fresh uid — random,
 * global, the app's to draw (the domain draws no random numbers). Asked
 * once per task made. */
export interface CreateContext extends TransitionContext {
  mintUid(): string;
}

/** Every write's answer: the task as it now stands, and the board it
 * stands on — tasks and links alike, so a caller commits ONE value and a
 * batch hands each change the board the last one left. The SAME board
 * when nothing changed. */
export type TransitionResult =
  | { ok: true; task: Task; board: TaskBoard }
  | { ok: false; refusal: TaskRefusal };

/** A change to the task alone, before it is put back on the board. */
type TaskOnly = { ok: true; task: Task; board?: TaskBoard } | { ok: false; refusal: TaskRefusal };

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

/** A step an agent makes: from one status to another. */
export type StatusStep = readonly [from: TaskStatus, to: TaskStatus];

/**
 * The assignee's own steps — the lead's and the user's too. A backlog task
 * is no one's to START until it is moved to todo; one handed in for review
 * is withdrawn by its own assignee to finish what it found missing.
 */
export const WORKER_STEPS: readonly StatusStep[] = [
  ["backlog", "todo"],
  ["todo", "backlog"],
  ["todo", "in-progress"],
  ["in-progress", "blocked"],
  ["blocked", "in-progress"],
  ["in-progress", "review"],
  ["review", "in-progress"],
];

const OPEN_STATUSES = TASK_STATUSES.filter(isOpen);
const isWorkerStep = (from: TaskStatus, to: TaskStatus) => WORKER_STEPS.some(([f, t]) => f === from && t === to);

/**
 * Every move an agent may make, and whose it is. `worker` edges are the
 * assignee's (and the lead's, and the user's); `acceptor` edges belong to
 * whoever hands out work, who runs the queue: any move between open
 * statuses, acceptance from review only (done means accepted, a step of
 * its own even for the lead's own task), cancelling anything open, and
 * reopening a closed task into todo or the backlog (task-285).
 */
const EDGES: readonly { from: TaskStatus; to: TaskStatus; who: "worker" | "acceptor" }[] = [
  ...WORKER_STEPS.map(([from, to]) => ({ from, to, who: "worker" as const })),
  ...OPEN_STATUSES.flatMap((from) =>
    OPEN_STATUSES.filter((to) => to !== from && !isWorkerStep(from, to)).map((to) => ({ from, to, who: "acceptor" as const })),
  ),
  { from: "review", to: "done", who: "acceptor" },
  ...OPEN_STATUSES.map((from) => ({ from, to: "cancelled" as const, who: "acceptor" as const })),
  ...(["done", "cancelled"] as const).flatMap((from) =>
    (["todo", "backlog"] as const).map((to) => ({ from, to, who: "acceptor" as const })),
  ),
];

/**
 * Where an agent's move needs every blocker resolved: entering work (a
 * start from the queue, a resume from blocked) and acceptance — a task waiting on open work is neither
 * to be begun nor called done. The one rule `issuable` also reads, asked
 * here of the SAME blockers. Every other move steps away from the work and
 * is never held up by them. The user is held to neither.
 */
function needsBlockersResolved(from: TaskStatus, to: TaskStatus): boolean {
  return entersWork(from, to) || (from === "review" && to === "done");
}

/** A move that starts or resumes work — from the queue or a block. Out of
 * review into in-progress is a send-back, or the assignee's withdrawal to
 * finish what review found: back to work already begun, not a start. */
function entersWork(from: TaskStatus, to: TaskStatus): boolean {
  return to === "in-progress" && from !== "review";
}

function joined(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(",");
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
}

/** A label as the board keeps it: in its compatibility-composed form
 * (NFKC — a decomposed "café" and a full-width "２０２６" are the label
 * their plain spelling is), trimmed, lowercased, runs of spaces,
 * underscores and dashes made one dash, none at either end — "Copy Edit"
 * is `copy-edit`. */
export function normalizeLabel(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A word in any script: it starts on a letter or digit, and goes on in
 * letters, digits, the marks a script writes on them (हिन्दी's vowel
 * signs, Hebrew points, the dot "İ" lowercases to) and the zero-width
 * joiners a script spells with (Persian's ZWNJ, Devanagari's conjuncts) —
 * words joined by single dashes. */
const LABEL_WORD =
  /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lm}\p{Lo}\p{N}\p{M}\u200C\u200D]*(-[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lm}\p{Lo}\p{N}\p{M}\u200C\u200D]*)*$/u;

/** A label's length as a person counts it — characters, not the UTF-16
 * units an ideograph outside the basic plane takes two of. */
function labelLength(label: string): number {
  return [...label].length;
}

/** A task's labels as kept — normalised, deduped, sorted, so a reordering
 * is no edit — or why they cannot be. The one rule the change and the
 * create apply. */
export function normalizeLabels(
  raw: readonly string[],
): { ok: true; labels: string[] } | { ok: false; refusal: TaskRefusal } {
  const labels = [...new Set(raw.map(normalizeLabel))].sort();
  const max = TASK_CAPS.labelMax;
  const bad = labels.find((label) => labelLength(label) > max || !LABEL_WORD.test(label));
  if (bad !== undefined) return refuse({ kind: "bad-label", label: bad, max });
  if (labels.length > TASK_CAPS.labelsMax) {
    return refuse({ kind: "too-many-labels", max: TASK_CAPS.labelsMax });
  }
  return { ok: true, labels };
}

/** Whether this actor sets a task's labels: whoever hands out work, and
 * the assignee on its own task — a label is how it files what it holds. */
function mayLabel(actor: TaskActor, task: Pick<Task, "assignee">): boolean {
  return mayAssign(actor) || (actor.kind === "agent" && actor.role !== null && task.assignee === actor.role);
}

/** What is wrong with a title, or nothing — the rule the transition and
 * the create apply, and the one a form asks before offering to submit. */
export function titleProblem(title: string): TaskRefusal | null {
  return validateTitle(title);
}

/** The capped text fields, and each one's cap. */
export type CappedField = "title" | "body" | "comment";
const CAPS: Record<CappedField, number> = {
  title: TASK_CAPS.titleMax,
  body: TASK_CAPS.bodyMax,
  comment: TASK_CAPS.commentMax,
};

export function capOf(field: CappedField): number {
  return CAPS[field];
}

/** A capped field's length as it is KEPT, and in the unit a person counts
 * (characters, not UTF-16 units — the labels' measure too): a title and a
 * comment are stored trimmed, so spaces at their ends never count; a brief
 * is stored as written. The one measure the caps, the refusals and the
 * fields' counters all read. */
export function keptLength(field: CappedField, text: string): number {
  const kept = field === "body" ? text : field === "title" ? keptTitle(text) : text.trim();
  return [...kept].length;
}

function overCap(field: CappedField, text: string): TaskRefusal | null {
  const length = keptLength(field, text);
  return length > CAPS[field] ? { kind: "field-cap", field, max: CAPS[field], length } : null;
}

/** What is wrong with a comment, or nothing — same rule as the comment
 * change applies. */
export function commentProblem(body: string): TaskRefusal | null {
  if (body.trim() === "") return { kind: "blank", field: "comment" };
  return overCap("comment", body);
}

/** A title is measured as it is kept — trimmed: spaces at its ends are
 * never stored, so they never count against the cap. */
function validateTitle(title: string): TaskRefusal | null {
  if (keptTitle(title) === "") return { kind: "blank", field: "title" };
  return overCap("title", title);
}

/** A title as it is kept: ONE line — a pasted line break becomes a space —
 * trimmed. The board, the rows and the log all read a title as a line. */
export function keptTitle(title: string): string {
  return title.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function validateBody(body: string): TaskRefusal | null {
  return overCap("body", body);
}

/** What is wrong with a brief, or nothing — the rule the change and the
 * create apply, and the one a form asks before offering to submit. */
export function bodyProblem(body: string): TaskRefusal | null {
  return validateBody(body);
}

function validateAssignee(
  assignee: string | null,
  roster: readonly string[],
): TaskRefusal | null {
  return assignee === null || roster.includes(assignee)
    ? null
    : { kind: "assignee-not-on-team", assignee };
}

/** What is wrong with `id` as a blocker of `waiting` (null for a task
 * being made, which nothing waits on yet), or null: THE rule, asked of
 * one blocker at a time — by the change and by the pickers alike.
 * `waitsOnWaiting` says whether a task (by uid) already waits on
 * `waiting`, however far down: the caller walks the board once for all
 * it asks. */
type BlockerFault = "self" | "unknown" | "foreign" | "cyclic";

function blockerFault(
  waiting: Task | null,
  teamId: string,
  id: string,
  board: TaskBoard,
  waitsOnWaiting: (uid: string) => boolean,
): BlockerFault | null {
  if (waiting !== null && id === waiting.id) return "self";
  const blocker = findTask(board, id);
  if (blocker === undefined) return "unknown";
  if (blocker.teamId !== teamId) return "foreign";
  // A blocker that already waits on this task would close a loop — a
  // deadlock the board would never surface but as "nothing is issuable".
  if (waiting !== null && waitsOnWaiting(blocker.uid)) return "cyclic";
  return null;
}

/**
 * Blockers must name tasks of the same team that exist, are not the task
 * itself, and do not lead back to it (`blockerFault`), refused naming
 * every one of the first kind that fails.
 */
function validateBlockers(
  task: Task | null,
  teamId: string,
  ids: readonly string[],
  board: TaskBoard,
): TaskRefusal | null {
  const waiters = task === null ? null : transitiveWaiters(board, task.uid);
  const faults = ids.map((id) => ({ id, fault: blockerFault(task, teamId, id, board, (uid) => waiters?.has(uid) ?? false) }));
  const of = (fault: BlockerFault) => faults.filter((entry) => entry.fault === fault).map((entry) => entry.id);
  if (of("self").length > 0) return { kind: "self-blocker" };
  if (of("unknown").length > 0) return { kind: "unknown-blocker", ids: of("unknown") };
  if (of("foreign").length > 0) return { kind: "cross-team-blocker", ids: of("foreign") };
  if (of("cyclic").length > 0) return { kind: "cyclic-blocker", ids: of("cyclic") };
  return null;
}

/**
 * What is wrong with putting `task` under the epic `id`, or null — THE
 * family rule, asked by the create, the `parent` change and every picker:
 * the epic is on the board and is an epic, of the task's team; the task
 * is work (an epic has no epic: what each end of the link must be is the
 * table's, `RelationRule.ends`); and open work enters no closed epic.
 */
export function parentProblem(
  task: Pick<Task, "kind" | "teamId" | "status">,
  id: string,
  board: TaskBoard,
): TaskRefusal | null {
  const ends = RELATION_KINDS["child-of"].ends!;
  if (task.kind !== ends.from) return { kind: "epic-under-epic" };
  const epic = findTask(board, id);
  if (epic === undefined) return { kind: "unknown-epic", id };
  if (epic.kind !== ends.to) return { kind: "not-an-epic", id };
  if (epic.teamId !== task.teamId) return { kind: "cross-team-epic", id };
  if (isOpen(task.status) && !isOpen(epic.status)) return { kind: "closed-epic", id };
  return null;
}

/** The epics `task` could be put under now — its team's, open (or any,
 * for a closed task), not the one it is under — in board order: what a
 * picker offers, so it never offers what the change refuses. */
export function epicCandidates(task: Task, board: TaskBoard): Task[] {
  const current = epicOf(task, board);
  return tasksOfTeam(board, task.teamId).filter((epic) => epic !== current && parentProblem(task, epic.id, board) === null);
}

/**
 * What a status move breaks of the family, or null: an epic does not
 * close while work under it is open (`openWorkUnder`), and a closed task
 * does not reopen under a closed epic. The one rule that binds the person
 * as it binds every agent — the board would otherwise say "closed" of an
 * epic with work going on under it.
 */
export function epicMoveProblem(task: Task, to: TaskStatus, board: TaskBoard): TaskRefusal | null {
  if (task.kind === "epic" && !isOpen(to)) {
    const open = openWorkUnder(task, board);
    if (open.length > 0) return { kind: "epic-has-open-work", open: open.map((other) => ({ id: other.id, status: other.status })) };
  }
  if (!isOpen(task.status) && isOpen(to)) {
    const epic = epicOf(task, board);
    if (epic !== null && !isOpen(epic.status)) return { kind: "closed-epic", id: epic.id };
  }
  return null;
}

/** Which side of a blocker link `task` is to stand on: it waits on the
 * other (`blocked-by`), or the other waits on it (`blocks`). */
export type BlockerSide = "blocked-by" | "blocks";

/** The tasks `task` could be linked to as `side` says, now: its team's
 * open tasks the `blockedBy` change would take on the waiting end — not
 * itself, no link twice, none closing a cycle — in board order. A picker
 * offers exactly these, so it never offers what the change refuses. */
export function blockerCandidates(task: Task, board: TaskBoard, side: BlockerSide = "blocked-by"): Task[] {
  const may = mayLink(task, board, side);
  return tasksOfTeam(board, task.teamId).filter(may);
}

/** Whether any task could be linked to `task` as `side` says — what a +
 * or a menu item asks, stopping at the first. */
export function hasBlockerCandidate(task: Task, board: TaskBoard, side: BlockerSide): boolean {
  return tasksOfTeam(board, task.teamId).some(mayLink(task, board, side));
}

/** THE rule both ask, of each `other`: it is open, not `task`, not linked
 * to it this way already, and `blockerFault` finds nothing in the link on
 * its waiting end. The board is walked ONCE for the loop check — from
 * `task`, whichever side it stands on — not once per task offered: a
 * team of two thousand would otherwise take seconds. */
function mayLink(task: Task, board: TaskBoard, side: BlockerSide): (other: Task) => boolean {
  if (side === "blocked-by") {
    // `task` waits on `other`: a loop if `other` already waits on `task`.
    const waiters = transitiveWaiters(board, task.uid);
    const current = new Set(blockerIdsOf(task, board));
    return (other) =>
      isOpen(other.status) &&
      other.uid !== task.uid &&
      !current.has(other.id) &&
      blockerFault(task, task.teamId, other.id, board, (uid) => waiters.has(uid)) === null;
  }
  // `other` waits on `task`: a loop if `task` already waits on `other`.
  const below = transitiveBlockers(board, task.uid);
  return (other) =>
    isOpen(other.status) &&
    other.uid !== task.uid &&
    !blockerIdsOf(other, board).includes(task.id) &&
    blockerFault(other, other.teamId, task.id, board, () => below.has(other.uid)) === null;
}

/** The change that links `task` to `other` as `side` says, and the task
 * it is made on — always the waiting one, whose blockers it sets. */
export function blockerLink(task: Task, other: Task, side: BlockerSide): { taskId: string; change: TaskChange } {
  return side === "blocked-by"
    ? { taskId: task.id, change: addBlocker(other.id) }
    : { taskId: other.id, change: addBlocker(task.id) };
}

/** The uids of the tasks named by `ids` — every one known (validated). */
function uidsOf(board: TaskBoard, ids: readonly string[]): string[] {
  return ids.map((id) => findTask(board, id)!.uid);
}

/** Whether two key lists name the same tasks, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function logged(
  task: Task,
  entries: readonly TaskLogEntry[],
  at: number,
  patch: Partial<Task>,
): Task {
  const log = [...task.log, ...entries];
  return { ...task, ...patch, log, updated: at };
}

/** Apply one change to one task, or say why not. */
export function transition(
  task: Task,
  change: TaskChange,
  actor: TaskActor,
  ctx: TransitionContext,
): TransitionResult {
  const result = changeTask(task, change, actor, ctx);
  if (!result.ok) return result;
  if (result.board) return { ok: true, task: result.task, board: result.board };
  return {
    ok: true,
    task: result.task,
    board: result.task === task ? ctx.board : replaceTask(ctx.board, result.task),
  };
}

function changeTask(
  task: Task,
  change: TaskChange,
  actor: TaskActor,
  ctx: TransitionContext,
): TaskOnly {
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
      const title = keptTitle(change.to);
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
      // The previous brief becomes a version; the log says which version
      // replaced which, by whom and when. Every version is kept exactly
      // once, and the log holds no brief text.
      const next = task.bodyV + 1;
      return {
        ok: true,
        task: logged(task, [{ at, from: by, field: "body", was: String(task.bodyV), now: String(next) }], at, {
          body: change.to,
          bodyV: next,
          briefs: [...task.briefs, { v: task.bodyV, body: task.body }],
        }),
      };
    }
    case "blockedBy": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "blockedBy" });
      const ids = normalizeIds(change.to);
      const bad = validateBlockers(task, task.teamId, ids, ctx.board);
      if (bad) return refuse(bad);
      const was = blockerIdsOf(task, ctx.board);
      if (sameIds(ids, was)) return { ok: true, task };
      const linkedNow = setBlockers(ctx.board, task, uidsOf(ctx.board, ids), at, by);
      // Both sides of the entry in board order: a set read back in another
      // order is the same set, and the log should not say otherwise.
      const now = blockerIdsOf(task, linkedNow);
      const changed = logged(task, [{ at, from: by, field: "blockedBy", was: joined(was), now: joined(now) }], at, {});
      return { ok: true, task: changed, board: replaceTask(linkedNow, changed) };
    }
    case "parent": {
      if (!mayAssign(actor)) return refuse({ kind: "not-yours-to-assign", field: "parent" });
      const id = change.to === null ? null : change.to.trim();
      const was = epicOf(task, ctx.board)?.id ?? null;
      if (id === was) return { ok: true, task };
      if (id !== null) {
        const bad = parentProblem(task, id, ctx.board);
        if (bad) return refuse(bad);
      }
      const epic = id === null ? null : findTask(ctx.board, id)!.uid;
      const changed = logged(task, [{ at, from: by, field: "parent", was, now: id }], at, {});
      return { ok: true, task: changed, board: replaceTask(setEpic(ctx.board, task, epic, at, by), changed) };
    }
    case "addBlocker":
      return changeTask(task, { kind: "blockedBy", to: [...blockerIdsOf(task, ctx.board), change.id] }, actor, ctx);
    case "removeBlocker":
      return changeTask(
        task,
        { kind: "blockedBy", to: blockerIdsOf(task, ctx.board).filter((id) => id !== change.id) },
        actor,
        ctx,
      );
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
    case "labels": {
      if (!mayLabel(actor, task)) return refuse({ kind: "not-yours-to-label", assignee: task.assignee });
      const read = normalizeLabels(change.to);
      if (!read.ok) return read;
      if (joined(read.labels) === joined(task.labels)) return { ok: true, task };
      return {
        ok: true,
        task: logged(
          task,
          [{ at, from: by, field: "labels", was: joined(task.labels), now: joined(read.labels) }],
          at,
          { labels: read.labels },
        ),
      };
    }
    case "addLabel":
      return changeTask(task, { kind: "labels", to: [...task.labels, change.label] }, actor, ctx);
    case "removeLabel": {
      const gone = normalizeLabel(change.label);
      return changeTask(task, { kind: "labels", to: task.labels.filter((label) => label !== gone) }, actor, ctx);
    }
    case "comment": {
      const problem = commentProblem(change.body);
      if (problem) return refuse(problem);
      const body = change.body.trim();
      // Ordinals never repeat: the next is one past the highest.
      const n = task.comments.reduce((top, c) => Math.max(top, c.n), 0) + 1;
      const comments = [...task.comments, { n, at, from: by, body }];
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
): TaskOnly {
  if (to === task.status) return { ok: true, task };
  const family = epicMoveProblem(task, to, ctx.board);
  if (family) return refuse(family);
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
  if (edge.who === "acceptor" && !mayAssign(actor)) return refuse({ kind: "not-yours-to-move" });
  const role = actor.role;
  const starts = entersWork(task.status, to);
  // A working role moves its own task — or a pool task waiting in todo,
  // which it takes by starting it, and only so.
  if (!mayAssign(actor) && task.assignee !== role && !(task.assignee === null && task.status === "todo" && starts)) {
    return refuse({ kind: "not-your-task", assignee: task.assignee });
  }
  if (needsBlockersResolved(edge.from, edge.to)) {
    const open = openBlockersOf(task, ctx.board);
    if (open.length > 0) return refuse({ kind: "blocked-by-open", blockers: open });
  }
  const assignee = assigneeAfter(task, to, role);
  const entries: TaskLogEntry[] = [];
  if (assignee !== task.assignee) entries.push({ at: ctx.at, from: by, field: "assignee", was: task.assignee, now: assignee });
  entries.push({ at: ctx.at, from: by, field: "status", was: task.status, now: to });
  return { ok: true, task: logged(task, entries, ctx.at, { status: to, assignee }) };
}

/**
 * Who holds a task after an agent's move (task-285): a pool task started
 * is the starter's — a working role, a lead or a peer alike; a task sent
 * from work back to the queue (todo or the backlog) goes back to the pool.
 * Every other move leaves the holder as it was: the assignee's own
 * parking, a reopening, a block.
 */
function assigneeAfter(task: Task, to: TaskStatus, role: string | null): string | null {
  if (task.assignee === null && entersWork(task.status, to)) return role;
  if (WORK_STATUSES.includes(task.status) && QUEUE_STATUSES.includes(to)) return null;
  return task.assignee;
}

/** Where work is under way, and where it waits to be taken. */
const WORK_STATUSES: readonly TaskStatus[] = ["in-progress", "blocked", "review"];
const QUEUE_STATUSES: readonly TaskStatus[] = ["todo", "backlog"];

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
  labels?: readonly string[];
  /** Where it starts: on the ladder (`todo`, the default) or parked in
   * the backlog — anyone may park an idea; starting it is another matter. */
  status?: CreateStatus;
  /** Work (the default) or an epic — anyone who may make a task may make
   * either. */
  kind?: TaskKind;
  /** The epic it is made under (a key): its author's choice, by the
   * family rule (`parentProblem`). */
  parent?: string;
}

/** The statuses a task may be created in. */
export type CreateStatus = Extract<TaskStatus, "todo" | "backlog">;
export const CREATE_STATUSES: readonly CreateStatus[] = ["todo", "backlog"];

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
  ctx: CreateContext,
): CreateResult {
  const membership = onTeam(actor, input.teamId);
  if (membership) return refuse(membership);
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
  const status = input.status ?? "todo";
  if (!(CREATE_STATUSES as readonly string[]).includes(status)) {
    return refuse({ kind: "bad-create-status", status, allowed: CREATE_STATUSES });
  }
  const labels = normalizeLabels(input.labels ?? []);
  if (!labels.ok) return labels;
  // The labelling rule the change applies: a working role labels only
  // what it holds — never a pool task it could not touch again.
  if (labels.labels.length > 0 && !mayLabel(actor, { assignee })) {
    return refuse({ kind: "not-yours-to-label", assignee });
  }
  const kind = input.kind ?? "task";
  if (!(TASK_KINDS as readonly string[]).includes(kind)) return refuse({ kind: "bad-create-kind", value: kind, allowed: TASK_KINDS });
  const parent = input.parent?.trim() || null;
  if (parent !== null) {
    const bad = parentProblem({ kind, teamId: input.teamId, status }, parent, ctx.board);
    if (bad) return refuse(bad);
  }
  const task: Task = {
    uid: ctx.mintUid(),
    id: `task-${ctx.board.nextId}`,
    teamId: input.teamId,
    kind,
    title: keptTitle(input.title),
    body,
    bodyV: 1,
    briefs: [],
    status,
    priority,
    assignee,
    author: actorName(actor) ?? "",
    artifacts: normalizeIds(input.artifacts ?? []),
    labels: labels.labels,
    comments: [],
    log: [],
    created: ctx.at,
    updated: ctx.at,
  };
  const added = withTasks({ ...ctx.board, nextId: ctx.board.nextId + 1 }, [...ctx.board.tasks, task]);
  const blocked = setBlockers(added, task, uidsOf(ctx.board, blockedBy), ctx.at, actorName(actor));
  return {
    ok: true,
    task,
    board: parent === null ? blocked : setEpic(blocked, task, findTask(ctx.board, parent)!.uid, ctx.at, actorName(actor)),
  };
}

/**
 * A copy of `source`, made as a fresh task: its title, brief, priority,
 * labels, artifacts and blockers, on its team, in todo — or in the
 * backlog when the source is parked — and held by no one. Not its
 * comments, its log, its dates or its assignee: a copy starts its own
 * history, which opens with where it came from, and the source's log says
 * where it was copied to.
 *
 * By the create's own rules (`createTask`): what the actor may not set at
 * creation is left at its default rather than refusing the copy — a
 * working role's copy is at normal priority, and carries labels only when
 * the actor could label a pool task (whoever hands out work) — and what
 * was left is answered (`notCarried`), for whoever asked to say so.
 *
 * Its blockers are the source's that still hold — a blocker done,
 * cancelled or gone holds nothing, and a copy is new work. A copy is
 * nearly a read of the source: the source's log records it, but its
 * `updated` stays — copying an old task must not bring it to the top.
 */
export function duplicateTask(
  source: Task,
  actor: TaskActor,
  ctx: CreateContext,
):
  | { ok: true; board: TaskBoard; task: Task; source: Task; notCarried: NotCarried[] }
  | { ok: false; refusal: TaskRefusal } {
  const priority = mayAssign(actor) ? source.priority : DEFAULT_PRIORITY;
  const labels = mayLabel(actor, { assignee: null }) ? source.labels : [];
  const made = createTask(
    {
      teamId: source.teamId,
      title: source.title,
      body: source.body,
      assignee: null,
      priority,
      blockedBy: openBlockersOf(source, ctx.board),
      artifacts: source.artifacts,
      labels,
      status: source.status === "backlog" ? "backlog" : "todo",
    },
    actor,
    ctx,
  );
  if (!made.ok) return made;
  const by = actorName(actor) ?? "";
  const copy = logged(made.task, [{ at: ctx.at, from: by, field: "copiedFrom", was: null, now: source.id }], ctx.at, {});
  const original = logged(
    source,
    [{ at: ctx.at, from: by, field: "copiedTo", was: null, now: copy.id }],
    source.updated,
    {},
  );
  const notCarried: NotCarried[] = [
    ...(priority !== source.priority ? [{ field: "priority" as const, was: source.priority }] : []),
    ...(labels.length < source.labels.length ? [{ field: "labels" as const, was: source.labels.join(",") }] : []),
  ];
  const board = linked(replaceTask(replaceTask(made.board, copy), original), {
    kind: "copied-from",
    from: copy.uid,
    to: source.uid,
    at: ctx.at,
    by: actorName(actor),
  });
  return { ok: true, board, task: copy, source: original, notCarried };
}

/** What a copy left at its default, and what the source had there. */
export type NotCarried = { field: "priority" | "labels"; was: string };

/** The teams a transfer is between: their ids, and their names as the log
 * keeps them. The target is a live team of the workspace — the caller's to
 * know (the deck), not the board's. */
export interface TransferTeams {
  from: { id: string; name: string };
  to: { id: string; name: string };
}

/** Why `task` may not be transferred by `actor` now, or null when it may —
 * everything but the target, which only the caller knows: the rule the
 * transfer applies and a menu asks before offering it. */
export function transferProblem(task: Task, actor: TaskActor, board: TaskBoard): TaskRefusal | null {
  const membership = onTeam(actor, task.teamId);
  if (membership) return membership;
  if (!mayAssign(actor)) return { kind: "not-yours-to-transfer" };
  if (!isOpen(task.status)) return { kind: "transfer-closed", status: task.status };
  // Live links only: a resolved blocker holds nothing, a closed dependant
  // waits on nothing — so neither refuses; the move takes those links off.
  const blockers = openBlockersOf(task, board);
  const dependants = unblocks(task, board)
    .filter((other) => isOpen(other.status))
    .map((other) => other.id);
  if (blockers.length > 0 || dependants.length > 0) {
    return { kind: "transfer-linked", blockers, dependants };
  }
  return null;
}

/**
 * Hand `task` to another team of the same workspace: the same task — its
 * id, brief, labels, priority, artifacts, comments and log — on the
 * target's board, held by no one (a role belongs to its team) and back at
 * the ladder's start: todo, or the backlog if it was parked.
 *
 * No blocker link may cross teams, so the ones that hold nothing go both
 * ways (`withoutGates`): its resolved blockers, and its id from the CLOSED
 * tasks that named it (a reopened one would otherwise wait on another
 * team's task). A copy's link is a fact and goes with it, across teams; a
 * link to a task not on this board is not this board's to judge. The log says
 * `transferred: A → B` and, before it, every field the move reset — who
 * held it, where it stood, what it waited on — so the history reads whole.
 */
export function transferTask(
  task: Task,
  teams: TransferTeams,
  actor: TaskActor,
  ctx: TransitionContext,
): { ok: true; task: Task; board: TaskBoard } | Refused {
  if (teams.to.id === task.teamId) return refuse({ kind: "transfer-same-team" });
  const problem = transferProblem(task, actor, ctx.board);
  if (problem) return refuse(problem);
  const by = actorName(actor) ?? "";
  const at = ctx.at;
  const status: TaskStatus = task.status === "backlog" ? "backlog" : "todo";
  const waited = blockerIdsOf(task, ctx.board);
  const reset: TaskLogEntry[] = [
    ...(task.assignee !== null ? [{ at, from: by, field: "assignee" as const, was: task.assignee, now: null }] : []),
    ...(task.status !== status ? [{ at, from: by, field: "status" as const, was: task.status, now: status }] : []),
    ...(waited.length > 0 ? [{ at, from: by, field: "blockedBy" as const, was: joined(waited), now: null }] : []),
  ];
  const moved = logged(
    task,
    [...reset, { at, from: by, field: "transferred", was: teams.from.name, now: teams.to.name }],
    at,
    { teamId: teams.to.id, assignee: null, status },
  );
  let board = replaceTask(ctx.board, moved);
  for (const dependant of unblocks(task, ctx.board)) {
    const was = blockerIdsOf(dependant, ctx.board);
    const now = was.filter((id) => id !== task.id);
    board = replaceTask(
      board,
      logged(dependant, [{ at, from: by, field: "blockedBy", was: joined(was), now: joined(now) }], dependant.updated, {}),
    );
  }
  // Every blocker link it was in goes — what held it, and what it held
  // (logged above).
  board = withoutGates(board, task.uid);
  return { ok: true, task: moved, board };
}
