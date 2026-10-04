/**
 * Every question about how tasks are linked, answered in ONE place: the
 * board's relations are records (`TaskRelation`), and nothing else reads
 * or rebuilds them — the gate, the write paths, the board's housekeeping,
 * the surfaces and the commands all ask here. When links move out of one
 * board's file (task-224, task-221) this module and the codec are what
 * changes.
 *
 * Reading is tolerant of an end that is not on the board — a copy's
 * source on a disbanded team, a hand edit, tomorrow another workspace:
 * such an end is ABSENT, and each question says what absent means for it.
 */
import {
  RELATION_KINDS,
  blockerResolved,
  isRelationKind,
  type RelationKind,
  type Task,
  type TaskBoard,
  type TaskRelation,
  type TaskStatus,
} from "./model";

interface RelationIndex {
  byUid: ReadonlyMap<string, Task>;
  /** Where each task stands on the board — the order every list of
   * linked tasks reads in (the order they were made), never the uids'. */
  place: ReadonlyMap<string, number>;
  byKey: ReadonlyMap<string, Task>;
  /** Links by kind, from the `from` end's uid. */
  out: ReadonlyMap<string, readonly TaskRelation[]>;
  /** Links by kind, from the `to` end's uid. */
  into: ReadonlyMap<string, readonly TaskRelation[]>;
}

/** Built once per board — a board is a value, so its identity is its
 * version: every card and list row asks of the same index. */
const indexes = new WeakMap<TaskBoard, RelationIndex>();

function indexOf(board: TaskBoard): RelationIndex {
  const cached = indexes.get(board);
  if (cached) return cached;
  const byUid = new Map<string, Task>();
  const byKey = new Map<string, Task>();
  const place = new Map<string, number>();
  for (const [at, task] of board.tasks.entries()) {
    byUid.set(task.uid, task);
    byKey.set(task.id, task);
    place.set(task.uid, at);
  }
  const out = new Map<string, TaskRelation[]>();
  const into = new Map<string, TaskRelation[]>();
  const push = (map: Map<string, TaskRelation[]>, key: string, relation: TaskRelation) => {
    const list = map.get(key);
    if (list) list.push(relation);
    else map.set(key, [relation]);
  };
  for (const relation of board.relations) {
    push(out, `${relation.kind}\u0000${relation.from}`, relation);
    push(into, `${relation.kind}\u0000${relation.to}`, relation);
  }
  const index = { byUid, place, byKey, out, into };
  indexes.set(board, index);
  return index;
}

const NONE: readonly TaskRelation[] = [];

/** The links of `kind` going out of `uid` (it is their `from`). */
function outOf(board: TaskBoard, kind: RelationKind, uid: string): readonly TaskRelation[] {
  return indexOf(board).out.get(`${kind}\u0000${uid}`) ?? NONE;
}

/** The links of `kind` coming into `uid` (it is their `to`). */
function into(board: TaskBoard, kind: RelationKind, uid: string): readonly TaskRelation[] {
  return indexOf(board).into.get(`${kind}\u0000${uid}`) ?? NONE;
}

/** The task with key `id` (`task-N`), if the board holds it. */
export function findTask(board: TaskBoard, id: string): Task | undefined {
  return indexOf(board).byKey.get(id);
}

/** The task with `uid`, if the board holds it. */
export function taskByUid(board: TaskBoard, uid: string): Task | undefined {
  return indexOf(board).byUid.get(uid);
}

/** Where the task `uid` stands — or `"absent"` when this board does not
 * hold it. The gate's one question about a blocker: `"absent"` is its
 * own answer, not "resolved" folded in here, so a resolver for another
 * workspace's tasks (task-224) can answer it later. */
export function statusOf(board: TaskBoard, uid: string): TaskStatus | "absent" {
  return taskByUid(board, uid)?.status ?? "absent";
}

/** Whether a blocker in this state holds nothing: closed — or not on this
 * board, which a task is never deleted from but by its team's going, so
 * a phantom that blocks forever is the worse failure. */
function holdsNothing(status: TaskStatus | "absent"): boolean {
  return status === "absent" || blockerResolved(status);
}

/** The tasks `task` waits on, present on the board, in board order. */
export function blockersOf(task: Task, board: TaskBoard): Task[] {
  return present(board, into(board, "blocks", task.uid).map((relation) => relation.from));
}

/** The keys of the tasks `task` waits on — what `blockedBy` reads as. */
export function blockerIdsOf(task: Task, board: TaskBoard): string[] {
  return blockersOf(task, board).map((blocker) => blocker.id);
}

/** The blockers of `task` that still stand: open, and on the board. */
export function openBlockersOf(task: Task, board: TaskBoard): string[] {
  // `holdsNothing` alone decides: an absent blocker is let go here, by
  // the rule, never by a lookup that happens to miss it.
  const open = GATING_KINDS.flatMap((kind) => into(board, kind, task.uid))
    .filter((relation) => !holdsNothing(statusOf(board, relation.from)))
    .map((relation) => relation.from);
  return inBoardOrder(board, [...new Set(open)]).map((uid) => taskByUid(board, uid)!.id);
}

/** The kinds that gate the ladder's start, read from the table. */
const GATING_KINDS: readonly RelationKind[] = (Object.keys(RELATION_KINDS) as RelationKind[]).filter(
  (kind) => RELATION_KINDS[kind].gatesStart,
);

/** Whether a link of `kind` holds its `to` off the ladder's start — the
 * table's column, for every rule that asks (the gate, a transfer). */
export function gatesStart(kind: string): boolean {
  return isRelationKind(kind) && RELATION_KINDS[kind].gatesStart;
}

/** The tasks waiting on `task` — the other side of `blocks`, present. */
export function unblocks(task: Task, board: TaskBoard): Task[] {
  return present(board, outOf(board, "blocks", task.uid).map((relation) => relation.to));
}

/** Where `task` was copied from: the source, `"absent"` when it has left
 * the board, or null for a task that is no copy. */
export function copiedFromOf(task: Task, board: TaskBoard): Task | "absent" | null {
  const link = outOf(board, "copied-from", task.uid)[0];
  if (!link) return null;
  return taskByUid(board, link.to) ?? "absent";
}

/** The copies made of `task` that are still on the board. */
export function copiesOf(task: Task, board: TaskBoard): Task[] {
  return present(board, into(board, "copied-from", task.uid).map((relation) => relation.from));
}

/** The tasks of `uids` this board holds, in board order. */
function present(board: TaskBoard, uids: readonly string[]): Task[] {
  const { place } = indexOf(board);
  return inBoardOrder(board, uids.filter((uid) => place.has(uid))).map((uid) => taskByUid(board, uid)!);
}

/** `uids`, every one on the board, in board order. */
function inBoardOrder(board: TaskBoard, uids: readonly string[]): string[] {
  const { place } = indexOf(board);
  return [...uids].sort((a, b) => place.get(a)! - place.get(b)!);
}

/** Whether following `blocks` backwards from `from` (what it waits on,
 * and what that waits on) ever arrives at `target`. */
export function waitsOn(board: TaskBoard, from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return into(board, "blocks", from).some((relation) => waitsOn(board, relation.from, target, seen));
}

/** Canonical order — kind, then from, then to — so the same links saved
 * twice are the same bytes. */
function compareRelations(a: TaskRelation, b: TaskRelation): number {
  return cmp(a.kind, b.kind) || cmp(a.from, b.from) || cmp(a.to, b.to);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The board with `tasks` in place of its own, its links kept — one of
 * the two ways a board is rebuilt, so no write can drop the links. */
export function withTasks(board: TaskBoard, tasks: readonly Task[]): TaskBoard {
  return { nextId: board.nextId, tasks, relations: board.relations };
}

/** The board with `relations` in place of its own, in canonical order. */
export function withRelations(board: TaskBoard, relations: readonly TaskRelation[]): TaskBoard {
  return { nextId: board.nextId, tasks: board.tasks, relations: [...relations].sort(compareRelations) };
}

/** The board with `task` in place of the one that shares its uid. */
export function replaceTask(board: TaskBoard, task: Task): TaskBoard {
  return withTasks(
    board,
    board.tasks.map((existing) => (existing.uid === task.uid ? task : existing)),
  );
}

/** The board with `task`'s blockers made `blockers` (uids), as a DIFF: a
 * link that stays keeps who made it and when, a new one is `by`'s at
 * `at`, a dropped one goes. The SAME board when nothing changes. */
export function setBlockers(
  board: TaskBoard,
  task: Task,
  blockers: readonly string[],
  at: number,
  by: string | null,
): TaskBoard {
  const current = into(board, "blocks", task.uid);
  const wanted = new Set(blockers);
  const kept = current.filter((relation) => wanted.has(relation.from));
  const had = new Set(current.map((relation) => relation.from));
  const added = blockers
    .filter((uid) => !had.has(uid))
    .map((uid): TaskRelation => ({ kind: "blocks", from: uid, to: task.uid, at, by }));
  if (added.length === 0 && kept.length === current.length) return board;
  const others = board.relations.filter((relation) => !(relation.kind === "blocks" && relation.to === task.uid));
  return withRelations(board, [...others, ...kept, ...added]);
}

/** The board with a link added — the duplicate's record of its source. */
export function linked(board: TaskBoard, relation: TaskRelation): TaskBoard {
  return withRelations(board, [...board.relations, relation]);
}

/** The board without the links `drop` picks — the SAME board when it
 * picks none. */
export function unlinked(board: TaskBoard, drop: (relation: TaskRelation) => boolean): TaskBoard {
  const kept = board.relations.filter((relation) => !drop(relation));
  return kept.length === board.relations.length ? board : withRelations(board, kept);
}

/** Whether `relation` stays once the tasks in `gone` have left the
 * board: a link with no end left goes; one whose `from` left goes (the
 * copy, or the blocker, is gone); one whose `to` left stays only as a
 * fact (`outlivesItsTo`). A kind this build does not know is carried while
 * either end is here — it is not ours to judge. */
export function outlives(relation: TaskRelation, gone: ReadonlySet<string>): boolean {
  const lostFrom = gone.has(relation.from);
  const lostTo = gone.has(relation.to);
  if (!lostFrom && !lostTo) return true;
  if (lostFrom && lostTo) return false;
  if (!isRelationKind(relation.kind)) return true;
  return !lostFrom && RELATION_KINDS[relation.kind].outlivesItsTo;
}
