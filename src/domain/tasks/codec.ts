/**
 * The board's stored form, in both directions.
 *
 * The store keeps bytes; this is the one place that says what bytes a
 * board is. Reading is UNTRUSTED: the file sits in the user's home where
 * any process of theirs can edit it, so every field is checked against the
 * vocabulary and a board that does not parse is refused WHOLE — cancelling
 * the tasks that did not fit and writing the rest back would erase them
 * on the next save, and losing work quietly is the worse failure. The
 * owner turns a refusal into a board it will not write to.
 */
import {
  isTaskPriority,
  isTaskStatus,
  type Task,
  type TaskBoard,
  type TaskComment,
  type TaskLogEntry,
} from "./model";

const TASK_FIELDS = new Set([
  "status",
  "assignee",
  "priority",
  "title",
  "body",
  "blockedBy",
  "artifacts",
]);

export type DecodeResult =
  | { ok: true; board: TaskBoard }
  | { ok: false; error: string };

export function encodeBoard(board: TaskBoard): string {
  return JSON.stringify(board);
}

export function decodeBoard(json: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `board.json is not JSON: ${(e as Error).message}` };
  }
  if (!isRecord(raw)) return { ok: false, error: "board.json is not an object" };
  const nextId = raw.nextId;
  if (!isCount(nextId) || nextId < 1) return { ok: false, error: "board.json: nextId must be a positive integer" };
  if (!Array.isArray(raw.tasks)) return { ok: false, error: "board.json: tasks must be an array" };
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.tasks.entries()) {
    const read = decodeTask(entry);
    if (!read.ok) return { ok: false, error: `board.json: tasks[${i}] ${read.error}` };
    if (seen.has(read.task.id)) return { ok: false, error: `board.json: duplicate task id ${read.task.id}` };
    seen.add(read.task.id);
    tasks.push(read.task);
  }
  return { ok: true, board: { nextId, tasks } };
}

function decodeTask(raw: unknown): { ok: true; task: Task } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "is not an object" };
  const id = raw.id;
  if (typeof id !== "string" || !/^task-\d+$/.test(id)) return { ok: false, error: "has no task id" };
  const fail = (what: string) => ({ ok: false as const, error: `${id}: ${what}` });
  if (typeof raw.teamId !== "string" || raw.teamId === "") return fail("teamId must be a string");
  if (typeof raw.title !== "string") return fail("title must be a string");
  if (typeof raw.body !== "string") return fail("body must be a string");
  if (typeof raw.status !== "string" || !isTaskStatus(raw.status)) return fail("status is not one of the ladder");
  if (typeof raw.priority !== "string" || !isTaskPriority(raw.priority)) return fail("priority is not high/normal/low");
  if (raw.assignee !== null && typeof raw.assignee !== "string") return fail("assignee must be a string or null");
  if (typeof raw.author !== "string") return fail("author must be a string");
  if (!isStringArray(raw.blockedBy)) return fail("blockedBy must be an array of ids");
  if (!isStringArray(raw.artifacts)) return fail("artifacts must be an array of ids");
  if (!Array.isArray(raw.comments) || !raw.comments.every(isComment)) return fail("comments are malformed");
  if (!Array.isArray(raw.log) || !raw.log.every(isLogEntry)) return fail("log is malformed");
  if (!isCount(raw.created) || !isCount(raw.updated)) return fail("created/updated must be timestamps");
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
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    TASK_FIELDS.has(value.field) &&
    (value.was === null || typeof value.was === "string") &&
    (value.now === null || typeof value.now === "string")
  );
}
