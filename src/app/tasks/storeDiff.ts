/**
 * What to write: the change from the board the database CONFIRMED to the
 * board the owner holds now, as the store's change set.
 *
 * Always against the confirmed board, never against the previous board in
 * memory: a write that failed moved nothing, so the next one carries its
 * changes too (review, task-263/262). The domain replaces only what a
 * change touches — every other task is the same object — so a task is
 * skipped by reference when it is the same object at the same place;
 * everything else is compared by value, which makes a board rebuilt whole
 * (a re-read, an upgrade) one bigger change, never a wrong one.
 *
 * History is APPENDED: the confirmed comments, log entries and brief
 * versions must be the start of the new ones. A board that rewrote one is
 * a broken invariant, refused here rather than written.
 */
import type { Task, TaskBoard, TaskRelation } from "../../domain/tasks";
import type { BoardChange } from "../../ipc/generated/tasks/BoardChange";
import type { StoredComment } from "../../ipc/generated/tasks/StoredComment";
import type { StoredLogEntry } from "../../ipc/generated/tasks/StoredLogEntry";
import type { StoredBrief } from "../../ipc/generated/tasks/StoredBrief";
import type { TaskWrite } from "../../ipc/generated/tasks/TaskWrite";
import type { StoredPlace } from "./storeWire";

/** A board whose history does not continue the confirmed one. */
export class HistoryRewritten extends Error {
  constructor(what: string) {
    super(`the board rewrote history the database already holds: ${what}`);
    this.name = "HistoryRewritten";
  }
}

/** The change from `confirmed` to `next`, or null when there is nothing to write. */
export function boardChange(confirmed: TaskBoard, next: TaskBoard, place: StoredPlace): BoardChange | null {
  const before = new Map(confirmed.tasks.map((task, pos) => [task.uid, { task, pos }]));
  const tasks: TaskWrite[] = [];
  next.tasks.forEach((task, pos) => {
    const was = before.get(task.uid);
    if (was && was.task === task && was.pos === pos) return;
    tasks.push(taskWrite(was?.task ?? null, task, pos));
  });
  const kept = new Set(next.tasks.map((task) => task.uid));
  const removed = confirmed.tasks.filter((task) => !kept.has(task.uid)).map((task) => task.uid);

  const key = (r: Pick<TaskRelation, "kind" | "from" | "to">) => `${r.kind}\u0000${r.from}\u0000${r.to}`;
  const linkedBefore = new Map(confirmed.relations.map((r) => [key(r), r]));
  const linkedNow = new Map(next.relations.map((r) => [key(r), r]));
  // A link is compared whole: removed and put back in one change, its
  // `at` and `by` are new though its ends are the same.
  const relationsPut = next.relations
    .filter((r) => {
      const old = linkedBefore.get(key(r));
      return !old || old.at !== r.at || old.by !== r.by;
    })
    .map((r) => ({ kind: r.kind, from: r.from, to: r.to, at: r.at, by: r.by }));
  const relationsRemoved = confirmed.relations
    .filter((r) => !linkedNow.has(key(r)))
    .map((r) => ({ kind: r.kind, from: r.from, to: r.to }));

  const unchanged =
    tasks.length === 0 && removed.length === 0 && relationsPut.length === 0 && relationsRemoved.length === 0 && next.nextId === confirmed.nextId;
  if (unchanged) return null;
  return {
    board: place.board,
    workspace: place.workspace,
    expectedRev: place.rev,
    nextId: next.nextId,
    tasks,
    removed,
    relationsPut,
    relationsRemoved,
  };
}

function taskWrite(was: Task | null, task: Task, pos: number): TaskWrite {
  return {
    uid: task.uid,
    boardPos: pos,
    teamId: task.teamId,
    title: task.title,
    body: task.body,
    bodyV: task.bodyV,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    author: task.author,
    created: task.created,
    updated: task.updated,
    // A task new to the board brings its address; one already there keeps its.
    key: was === null ? task.id : null,
    // Labels are a set; artifacts are in order — a reorder is a change.
    labels: was !== null && sameSet(was.labels, task.labels) ? null : [...task.labels],
    artifacts: was !== null && sameList(was.artifacts, task.artifacts) ? null : [...task.artifacts],
    comments: appended(was?.comments ?? [], task.comments, `${task.id}'s comments`, sameComment).map((c) => ({
      n: c.n,
      at: c.at,
      author: c.from,
      body: c.body,
    })) satisfies StoredComment[],
    log: appended(was?.log ?? [], task.log, `${task.id}'s log`, sameEntry).map((entry, i) => ({
      seq: (was?.log.length ?? 0) + i,
      at: entry.at,
      author: entry.from,
      field: entry.field,
      was: entry.was,
      now: entry.now,
    })) satisfies StoredLogEntry[],
    briefs: appended(was?.briefs ?? [], task.briefs, `${task.id}'s brief versions`, sameBrief).map((b) => ({
      v: b.v,
      body: b.body,
    })) satisfies StoredBrief[],
  };
}

/** What `now` adds after `before` — which must be its unchanged start. */
function appended<T>(before: readonly T[], now: readonly T[], what: string, same: (a: T, b: T) => boolean): readonly T[] {
  if (now.length < before.length) throw new HistoryRewritten(`${what} lost entries`);
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== now[i] && !same(before[i], now[i])) throw new HistoryRewritten(`${what}, entry ${i + 1}, changed`);
  }
  return now.slice(before.length);
}

type Comment = Task["comments"][number];
type Entry = Task["log"][number];
type Brief = Task["briefs"][number];
const sameComment = (a: Comment, b: Comment) => a.n === b.n && a.at === b.at && a.from === b.from && a.body === b.body;
const sameEntry = (a: Entry, b: Entry) =>
  a.at === b.at && a.from === b.from && a.field === b.field && a.was === b.was && a.now === b.now;
const sameBrief = (a: Brief, b: Brief) => a.v === b.v && a.body === b.body;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}
