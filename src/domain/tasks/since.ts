/**
 * What changed on a task after a mark — the one answer `task.since` gives
 * (task-221 §06): whether the task is new since then, how many comments
 * it gained, and which of its fields moved. The mark is a board change
 * number (exact) or a time (from that moment on, the moment included).
 */
import type { LogField, Task } from "./model";

/** When a task's parts landed, by the board's change numbers: the change
 * that made it (0: before the database), the latest one to touch it, and
 * the one each comment and each log entry landed in, in their order. */
export interface TaskLanding {
  created: number;
  rev: number;
  comments: readonly number[];
  log: readonly number[];
}

export type SinceMark = { kind: "rev"; rev: number } | { kind: "time"; at: number };

export interface TaskChangeSince {
  /** Made after the mark. */
  new: boolean;
  /** Comments it gained after the mark. */
  comments: number;
  /** The fields its log says moved after the mark, each once, in order. */
  fields: LogField[];
}

/** A mark as it is written: digits are a change number, anything else an
 * ISO time. Null when it is neither. */
export function sinceMark(text: string): SinceMark | null {
  if (/^\d+$/.test(text)) return { kind: "rev", rev: Number(text) };
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : { kind: "time", at };
}

/** The last moment anything of the task changed: its fields (`updated`),
 * and its log and thread — a copy made of it or a blocker of it handed
 * away writes its log without moving `updated`. */
export function changedAt(task: Task): number {
  return Math.max(task.updated, task.log[task.log.length - 1]?.at ?? 0, task.comments[task.comments.length - 1]?.at ?? 0);
}

/** What changed on `task` after `mark`, or null when nothing did. A rev
 * mark reads `landing` (none: nothing known to have landed since). */
export function changeSince(task: Task, mark: SinceMark, landing: TaskLanding | undefined): TaskChangeSince | null {
  if (mark.kind === "rev") {
    if (!landing || landing.rev <= mark.rev) return null;
    const after = (rev: number) => rev > mark.rev;
    return {
      new: landing.created > mark.rev,
      comments: landing.comments.filter(after).length,
      fields: fieldsOf(task.log.filter((_, i) => after(landing.log[i] ?? 0))),
    };
  }
  if (changedAt(task) < mark.at) return null;
  return {
    new: task.created >= mark.at,
    comments: task.comments.filter((comment) => comment.at >= mark.at).length,
    fields: fieldsOf(task.log.filter((entry) => entry.at >= mark.at)),
  };
}

function fieldsOf(entries: readonly Task["log"][number][]): LogField[] {
  return [...new Set(entries.map((entry) => entry.field))];
}
