/**
 * The board's stored form, in both directions.
 *
 * The store keeps bytes; this is the one place that says what bytes a
 * board is. Reading is UNTRUSTED: the file sits in the user's home where
 * any process of theirs can edit it, so every field is checked against the
 * vocabulary and a board that does not parse is refused WHOLE — dropping
 * the tasks that did not fit and writing the rest back would erase them
 * on the next save, and losing work quietly is the worse failure. The
 * owner turns a refusal into a board it will not write to.
 *
 * A fault is data, not English: the domain says WHAT did not fit and
 * WHERE, and the layer that speaks to a person or an agent puts it in
 * words.
 *
 * A board written before relations (no `relations` key) is MIGRATED, and
 * the migration is total — it never refuses a board the codec before it
 * accepted: every task gets a uid, its `blockedBy` becomes `blocks` links
 * (a repeat folded, a link to itself or to a key not on the board dropped
 * — they held nothing; a cycle or a link across teams kept — they show
 * and hold today), and a copy's link to its source is read from BOTH ends
 * of the log (either may have fallen off its cap), the latest kept.
 */
import {
  RELATION_KINDS,
  TASK_CAPS,
  LOG_FIELDS,
  isRelationKind,
  isTaskId,
  isTaskUid,
  isTaskPriority,
  isTaskStatus,
  type Task,
  type TaskBoard,
  type TaskBrief,
  type TaskComment,
  type TaskLogEntry,
  type TaskRelation,
} from "./model";
import { withRelations } from "./relations";
import { normalizeLabels } from "./transition";

const FIELDS = new Set<string>(LOG_FIELDS);

/** What the codec can say about a file it refused. */
export type DecodeFault =
  | { kind: "not-json"; detail: string }
  | { kind: "not-object" }
  | { kind: "tasks-not-array" }
  /** `nextId` is missing, not a safe positive integer, or would mint an
   * id a task already holds — the counter must stand above every task. */
  | { kind: "bad-counter"; atLeast: number }
  /** One task did not fit the vocabulary: which, and which field. */
  | { kind: "bad-task"; index: number; id: string | null; field: string }
  | { kind: "duplicate-id"; id: string }
  /** Two tasks with one uid — `id` the second's key. */
  | { kind: "duplicate-uid"; id: string }
  | { kind: "relations-not-array" }
  /** One link did not fit: which, which field, and the keys of its ends
   * (null for an end not on the board, or one that is no uid at all). */
  | { kind: "bad-relation"; index: number; field: string; from: string | null; to: string | null };

/** A legacy task's blockers the migration did not carry. */
export interface DroppedBlockers {
  id: string;
  blockers: readonly string[];
}

export type DecodeResult =
  | {
      ok: true;
      board: TaskBoard;
      /** Read from an older format — written before relations (its uids
       * freshly drawn) or before brief versions — for the owner to write
       * back at once (until then a re-read upgrades it afresh). */
      migrated: boolean;
      /** The blockers a migration let go — a task naming itself or a key
       * not on the board, which held nothing — for the owner to log. */
      dropped: readonly DroppedBlockers[];
    }
  | { ok: false; fault: DecodeFault };

/** The label a board written before relations is kept under, beside the
 * upgraded one (`board.<label>.json`) — the way back for an older build. */
export const PRE_RELATIONS_COPY = "pre-relations";

export function encodeBoard(board: TaskBoard): string {
  return JSON.stringify(board);
}

/** The number in a `task-N` id. */
function numberOf(id: string): number {
  return Number(id.slice("task-".length));
}

/** `mintUid` gives a task written before uids its own — the app's random
 * draw, injected so a read is deterministic under test. */
export function decodeBoard(json: string, mintUid: () => string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, fault: { kind: "not-json", detail: (e as Error).message } };
  }
  if (!isRecord(raw)) return { ok: false, fault: { kind: "not-object" } };
  if (!Array.isArray(raw.tasks)) return { ok: false, fault: { kind: "tasks-not-array" } };
  const legacy = raw.relations === undefined;
  if (!legacy && !Array.isArray(raw.relations)) return { ok: false, fault: { kind: "relations-not-array" } };
  const tasks: Task[] = [];
  /** A legacy task's `blockedBy`, by its uid — the links it becomes. */
  const waits = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  const uids = new Set<string>();
  let highest = 0;
  let upgraded = false;
  for (const [i, entry] of raw.tasks.entries()) {
    const read = decodeTask(entry, legacy, mintUid);
    if (!read.ok) return { ok: false, fault: { kind: "bad-task", index: i, id: read.id, field: read.field } };
    if (seen.has(read.task.id)) return { ok: false, fault: { kind: "duplicate-id", id: read.task.id } };
    // The codec before relations read no uid: a twin there is not a fault
    // it would have had, so the second one is drawn afresh.
    if (legacy && uids.has(read.task.uid)) read.task = { ...read.task, uid: mintUid() };
    if (uids.has(read.task.uid)) return { ok: false, fault: { kind: "duplicate-uid", id: read.task.id } };
    seen.add(read.task.id);
    uids.add(read.task.uid);
    highest = Math.max(highest, numberOf(read.task.id));
    tasks.push(read.task);
    if (read.upgraded) upgraded = true;
    if (read.blockedBy) waits.set(read.task.uid, read.blockedBy);
  }
  // The counter must be a safe integer above every id on the board, or
  // the next create mints a twin — which the next read then refuses.
  const nextId = raw.nextId;
  if (!Number.isSafeInteger(nextId) || (nextId as number) <= highest) {
    return { ok: false, fault: { kind: "bad-counter", atLeast: highest + 1 } };
  }
  const board: TaskBoard = { nextId: nextId as number, tasks, relations: [] };
  if (legacy) {
    const migrated = migratedRelations(tasks, waits);
    return { ok: true, board: withRelations(board, migrated.relations), migrated: true, dropped: migrated.dropped };
  }
  const relations = decodeRelations(raw.relations as unknown[], tasks);
  if (!relations.ok) return relations;
  return { ok: true, board: withRelations(board, relations.relations), migrated: upgraded, dropped: [] };
}

/** A legacy board's links: its blockers, and its copies' sources — and
 * the blockers it let go. */
function migratedRelations(
  tasks: readonly Task[],
  waits: ReadonlyMap<string, readonly string[]>,
): { relations: TaskRelation[]; dropped: DroppedBlockers[] } {
  const byKey = new Map(tasks.map((task) => [task.id, task]));
  const relations: TaskRelation[] = [];
  const dropped: DroppedBlockers[] = [];
  for (const task of tasks) {
    const gone: string[] = [];
    for (const key of new Set(waits.get(task.uid) ?? [])) {
      const blocker = byKey.get(key);
      if (!blocker || blocker === task) {
        gone.push(key);
        continue;
      }
      relations.push({ kind: "blocks", from: blocker.uid, to: task.uid, at: task.created, by: null });
    }
    if (gone.length > 0) dropped.push({ id: task.id, blockers: gone });
  }
  // A copy's source, from either end of the log — the latest per copy.
  const sources = new Map<string, TaskRelation>();
  const offer = (copy: Task | undefined, source: Task | undefined, entry: TaskLogEntry) => {
    if (!copy || !source || copy === source) return;
    const known = sources.get(copy.uid);
    if (known && known.at > entry.at) return;
    sources.set(copy.uid, { kind: "copied-from", from: copy.uid, to: source.uid, at: entry.at, by: entry.from });
  };
  for (const task of tasks) {
    for (const entry of task.log) {
      if (entry.now === null) continue;
      if (entry.field === "copiedFrom") offer(task, byKey.get(entry.now), entry);
      if (entry.field === "copiedTo") offer(byKey.get(entry.now), task, entry);
    }
  }
  return { relations: [...relations, ...sources.values()], dropped };
}

/** A board's links as stored, or the first that does not fit. An end not
 * on the board is no fault — a copy's source leaves with its team, and
 * the link stays (`outlivesItsTo`); a kind this build does not know is
 * carried as read. */
function decodeRelations(
  raw: readonly unknown[],
  tasks: readonly Task[],
): { ok: true; relations: TaskRelation[] } | { ok: false; fault: DecodeFault } {
  const keyOf = new Map(tasks.map((task) => [task.uid, task.id]));
  const relations: TaskRelation[] = [];
  const seen = new Set<string>();
  const sourced = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const end = (value: unknown) => (typeof value === "string" ? (keyOf.get(value) ?? null) : null);
    const fail = (field: string) => ({
      ok: false as const,
      fault: {
        kind: "bad-relation" as const,
        index,
        field,
        from: isRecord(entry) ? end(entry.from) : null,
        to: isRecord(entry) ? end(entry.to) : null,
      },
    });
    if (!isRecord(entry)) return fail("shape");
    const { kind, from, to, at, by } = entry;
    if (typeof kind !== "string" || kind === "") return fail("kind");
    if (typeof from !== "string" || !isTaskUid(from)) return fail("from");
    if (typeof to !== "string" || !isTaskUid(to)) return fail("to");
    if (!isCount(at)) return fail("at");
    if (by !== null && typeof by !== "string") return fail("by");
    if (from === to) return fail("an end linked to itself");
    const pair = `${kind}\u0000${from}\u0000${to}`;
    if (seen.has(pair)) return fail("a repeat of another link");
    seen.add(pair);
    if (isRelationKind(kind) && RELATION_KINDS[kind].onePerFrom) {
      const one = `${kind}\u0000${from}`;
      if (sourced.has(one)) return fail("a second link where one is the most");
      sourced.add(one);
    }
    relations.push({ kind, from, to, at, by });
  }
  return { ok: true, relations };
}

type TaskRead =
  /** `blockedBy` is a legacy task's, for the migration to link. */
  /** `upgraded`: written before brief versions, its log rewritten into them. */
  | { ok: true; task: Task; blockedBy?: readonly string[]; upgraded?: true }
  | { ok: false; id: string | null; field: string };

function decodeTask(raw: unknown, legacy: boolean, mintUid: () => string): TaskRead {
  if (!isRecord(raw)) return { ok: false, id: null, field: "shape" };
  const id = raw.id;
  if (typeof id !== "string" || !isTaskId(id)) return { ok: false, id: null, field: "id" };
  const fail = (field: string): TaskRead => ({ ok: false, id, field });
  // A legacy task may already carry one (a hand edit, a half-written
  // build): kept when it is one, drawn afresh when not — the codec before
  // relations never read it. On a new board every task must have its own.
  const valid = typeof raw.uid === "string" && isTaskUid(raw.uid);
  if (!legacy && !valid) return fail(raw.uid === undefined ? "uid (a board with relations gives every task one)" : "uid");
  const uid = valid ? (raw.uid as string) : mintUid();
  if (typeof raw.teamId !== "string" || raw.teamId === "") return fail("teamId");
  if (typeof raw.title !== "string") return fail("title");
  if (typeof raw.body !== "string") return fail("body");
  if (typeof raw.status !== "string" || !isTaskStatus(raw.status)) return fail("status");
  if (typeof raw.priority !== "string" || !isTaskPriority(raw.priority)) return fail("priority");
  if (raw.assignee !== null && typeof raw.assignee !== "string") return fail("assignee");
  if (typeof raw.author !== "string") return fail("author");
  // Blockers are links now: a new board holding them on a task as well
  // has two answers to one question, and which is true is not ours to
  // guess.
  if (legacy ? !isStringArray(raw.blockedBy) : raw.blockedBy !== undefined) {
    return fail(legacy ? "blockedBy" : "blockedBy (blockers are kept in relations)");
  }
  if (!isStringArray(raw.artifacts)) return fail("artifacts");
  // Absent on boards written before labels: absence is no fault. A hand
  // edit is read the way the board keeps labels ("B" is b, a repeat
  // folds) — or refused, like any field that does not fit.
  if (raw.labels !== undefined && !isStringArray(raw.labels)) return fail("labels");
  const labels = normalizeLabels(raw.labels ?? []);
  // Named, so a hand edit can be found and put right: which label, or how
  // many past the cap.
  if (!labels.ok) {
    const refusal = labels.refusal;
    return fail(refusal.kind === "bad-label" ? `label "${refusal.label}"` : `labels (more than ${TASK_CAPS.labelsMax})`);
  }
  if (!Array.isArray(raw.comments) || !raw.comments.every(isComment)) return fail("comments");
  if (!Array.isArray(raw.log) || !raw.log.every(isLogEntry)) return fail("log");
  if (!isCount(raw.created) || !isCount(raw.updated)) return fail("created/updated");
  // A task written before brief versions kept each previous brief whole
  // in its log: those texts become versions now, and the log says which
  // version replaced which.
  const briefs = raw.bodyV === undefined ? versionsFromLog(raw.log as TaskLogEntry[]) : readBriefs(raw.bodyV, raw.briefs);
  if (!briefs.ok) return fail(briefs.field);
  return {
    ok: true,
    ...(legacy ? { blockedBy: raw.blockedBy as string[] } : {}),
    ...(raw.bodyV === undefined ? { upgraded: true } : {}),
    task: {
      uid,
      id,
      teamId: raw.teamId,
      title: raw.title,
      body: raw.body,
      bodyV: briefs.bodyV,
      briefs: briefs.briefs,
      status: raw.status,
      priority: raw.priority,
      assignee: raw.assignee,
      author: raw.author,
      artifacts: raw.artifacts,
      labels: labels.labels,
      comments: raw.comments as TaskComment[],
      log: briefs.log ?? (raw.log as TaskLogEntry[]),
      created: raw.created,
      updated: raw.updated,
    },
  };
}

type BriefsRead =
  | { ok: true; bodyV: number; briefs: TaskBrief[]; log?: TaskLogEntry[] }
  | { ok: false; field: string };

/**
 * A task's brief versions from a log written before them, where each edit
 * kept the PREVIOUS brief whole in `was` (and `now` null). In log order,
 * those texts are versions 1, 2, …; the current brief is the next. Each
 * entry becomes "version k replaced by k + 1" — by whom and when unchanged
 * — so nothing a reader could see is lost, and the log holds no text.
 */
export function versionsFromLog(log: readonly TaskLogEntry[]): BriefsRead {
  const briefs: TaskBrief[] = [];
  const out: TaskLogEntry[] = [];
  for (const entry of log) {
    if (entry.field !== "body") {
      out.push(entry);
      continue;
    }
    if (entry.was === null || entry.now !== null) return { ok: false, field: "log (a brief edit that kept no previous brief)" };
    const v = briefs.length + 1;
    briefs.push({ v, body: entry.was });
    out.push({ ...entry, was: String(v), now: String(v + 1) });
  }
  return { ok: true, bodyV: briefs.length + 1, briefs, log: out };
}

/** Brief versions as written: 1, 2, … up to the one before the current. */
function readBriefs(bodyV: unknown, raw: unknown): BriefsRead {
  if (!isCount(bodyV) || bodyV < 1) return { ok: false, field: "bodyV" };
  if (!Array.isArray(raw)) return { ok: false, field: "briefs" };
  const briefs: TaskBrief[] = [];
  for (const [i, brief] of raw.entries()) {
    if (!isRecord(brief) || !onlyKeys(brief, ["v", "body"]) || brief.v !== i + 1 || typeof brief.body !== "string") {
      return { ok: false, field: `briefs (version ${i + 1})` };
    }
    briefs.push({ v: brief.v, body: brief.body });
  }
  if (briefs.length !== bodyV - 1) return { ok: false, field: "briefs (every version before the current one)" };
  return { ok: true, bodyV, briefs };
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isComment(value: unknown): value is TaskComment {
  return (
    isRecord(value) &&
    isCount(value.n) &&
    isCount(value.at) &&
    typeof value.from === "string" &&
    typeof value.body === "string"
  );
}

function isLogEntry(value: unknown): value is TaskLogEntry {
  return (
    isRecord(value) &&
    isCount(value.at) &&
    typeof value.from === "string" &&
    typeof value.field === "string" &&
    FIELDS.has(value.field) &&
    (value.was === null || typeof value.was === "string") &&
    (value.now === null || typeof value.now === "string")
  );
}
