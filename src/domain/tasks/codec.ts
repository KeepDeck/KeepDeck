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
 */
import {
  TASK_FIELDS,
  isTaskId,
  isTaskPriority,
  isTaskStatus,
  type Task,
  type TaskBoard,
  type TaskComment,
  type TaskLogEntry,
} from "./model";

const FIELDS = new Set<string>(TASK_FIELDS);

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
  | { kind: "duplicate-id"; id: string };

export type DecodeResult =
  | { ok: true; board: TaskBoard }
  | { ok: false; fault: DecodeFault };

export function encodeBoard(board: TaskBoard): string {
  return JSON.stringify(board);
}

/** The number in a `task-N` id. */
function numberOf(id: string): number {
  return Number(id.slice("task-".length));
}

export function decodeBoard(json: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, fault: { kind: "not-json", detail: (e as Error).message } };
  }
  if (!isRecord(raw)) return { ok: false, fault: { kind: "not-object" } };
  if (!Array.isArray(raw.tasks)) return { ok: false, fault: { kind: "tasks-not-array" } };
  const tasks: Task[] = [];
  const seen = new Set<string>();
  let highest = 0;
  for (const [i, entry] of raw.tasks.entries()) {
    const read = decodeTask(entry);
    if (!read.ok) return { ok: false, fault: { kind: "bad-task", index: i, id: read.id, field: read.field } };
    if (seen.has(read.task.id)) return { ok: false, fault: { kind: "duplicate-id", id: read.task.id } };
    seen.add(read.task.id);
    highest = Math.max(highest, numberOf(read.task.id));
    tasks.push(read.task);
  }
  // The counter must be a safe integer above every id on the board, or
  // the next create mints a twin — which the next read then refuses.
  const nextId = raw.nextId;
  if (!Number.isSafeInteger(nextId) || (nextId as number) <= highest) {
    return { ok: false, fault: { kind: "bad-counter", atLeast: highest + 1 } };
  }
  return { ok: true, board: { nextId: nextId as number, tasks } };
}

type TaskRead =
  | { ok: true; task: Task }
  | { ok: false; id: string | null; field: string };

function decodeTask(raw: unknown): TaskRead {
  if (!isRecord(raw)) return { ok: false, id: null, field: "shape" };
  const id = raw.id;
  if (typeof id !== "string" || !isTaskId(id)) return { ok: false, id: null, field: "id" };
  const fail = (field: string): TaskRead => ({ ok: false, id, field });
  if (typeof raw.teamId !== "string" || raw.teamId === "") return fail("teamId");
  if (typeof raw.title !== "string") return fail("title");
  if (typeof raw.body !== "string") return fail("body");
  if (typeof raw.status !== "string" || !isTaskStatus(raw.status)) return fail("status");
  if (typeof raw.priority !== "string" || !isTaskPriority(raw.priority)) return fail("priority");
  if (raw.assignee !== null && typeof raw.assignee !== "string") return fail("assignee");
  if (typeof raw.author !== "string") return fail("author");
  if (!isStringArray(raw.blockedBy)) return fail("blockedBy");
  if (!isStringArray(raw.artifacts)) return fail("artifacts");
  if (!Array.isArray(raw.comments) || !raw.comments.every(isComment)) return fail("comments");
  if (!Array.isArray(raw.log) || !raw.log.every(isLogEntry)) return fail("log");
  if (!isCount(raw.created) || !isCount(raw.updated)) return fail("created/updated");
  return {
    ok: true,
    task: {
      id,
      teamId: raw.teamId,
      title: raw.title,
      body: raw.body,
      status: raw.status,
      priority: raw.priority,
      assignee: raw.assignee,
      author: raw.author,
      blockedBy: raw.blockedBy,
      artifacts: raw.artifacts,
      comments: raw.comments as TaskComment[],
      log: raw.log as TaskLogEntry[],
      created: raw.created,
      updated: raw.updated,
    },
  };
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
