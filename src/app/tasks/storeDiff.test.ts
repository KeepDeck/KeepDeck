import { describe, expect, it } from "vitest";
import { createTask, keepTeams, transition, withTasks, type Task, type TaskBoard } from "../../domain/tasks";
import { board, lead, mintSequence, relation, task } from "../../domain/tasks/testSupport";
import { boardChange, HistoryRewritten } from "./storeDiff";
import { boardFromStored, storedFromBoard } from "./storeWire";

const PLACE = { board: "b-1", workspace: "ws-1", rev: 4 };
const at = 9_000;

/** `board` with `t` changed by `change`, as the owner would hold it. */
function changed(b: TaskBoard, id: string, change: Parameters<typeof transition>[1]): TaskBoard {
  const t = b.tasks.find((x) => x.id === id)!;
  const result = transition(t, change, lead, { board: b, roster: ["lead", "impl-1"], at });
  if (!result.ok) throw new Error(JSON.stringify(result.refusal));
  return result.board;
}

describe("boardChange — what to write, against the confirmed board", () => {
  const confirmed = board([task({ id: "task-1", assignee: "lead" }), task({ id: "task-2" })], 3);

  it("writes nothing when nothing changed", () => {
    expect(boardChange(confirmed, confirmed, PLACE)).toBeNull();
  });

  it("writes only the task a change touched, by reference, with the place and rev it was computed at", () => {
    const next = changed(confirmed, "task-1", { kind: "priority", to: "high" });
    const change = boardChange(confirmed, next, PLACE)!;
    expect(change).toMatchObject({ board: "b-1", workspace: "ws-1", expectedRev: 4, nextId: 3, removed: [] });
    expect(change.tasks.map((t) => t.uid)).toEqual(["uid-task-1"]);
    // The log line appended, numbered by its place in the whole log.
    expect(change.tasks[0].log).toEqual([{ seq: 0, at, author: "lead", field: "priority", was: "normal", now: "high" }]);
    // Unchanged sets are not rewritten.
    expect(change.tasks[0]).toMatchObject({ labels: null, artifacts: null, key: null, comments: [], briefs: [] });
    // What the task is goes with every write — the store keeps what it is told.
    expect(change.tasks[0].kind).toBe("task");
    const epic = { ...confirmed, tasks: confirmed.tasks.map((t, i) => (i === 0 ? { ...t, kind: "epic" as const } : t)) };
    expect(boardChange(confirmed, epic, PLACE)!.tasks[0].kind).toBe("epic");
  });

  it("numbers an appended log entry by its place in the WHOLE log", () => {
    const once = changed(confirmed, "task-1", { kind: "priority", to: "high" });
    const twice = changed(once, "task-1", { kind: "priority", to: "low" });
    expect(boardChange(once, twice, PLACE)!.tasks[0].log.map((e) => e.seq)).toEqual([1]);
  });

  it("carries a failed write's change in the next one — the diff is from the confirmed board, not the last in memory", () => {
    const afterB = changed(confirmed, "task-1", { kind: "comment", body: "B" });
    // B's write failed: the confirmed board is still `confirmed`. C comes next.
    const afterC = changed(afterB, "task-2", { kind: "comment", body: "C" });
    const change = boardChange(confirmed, afterC, PLACE)!;
    expect(change.tasks.map((t) => [t.uid, t.comments.map((c) => c.body)])).toEqual([
      ["uid-task-1", ["B"]],
      ["uid-task-2", ["C"]],
    ]);
  });

  it("writes a new task whole, with its address", () => {
    const made = createTask({ teamId: "team-1", title: "new", labels: ["ui"] }, lead, {
      board: confirmed,
      roster: ["lead"],
      at,
      mintUid: mintSequence("uid-n-"),
    });
    if (!made.ok) throw new Error("refused");
    const change = boardChange(confirmed, made.board, PLACE)!;
    expect(change.nextId).toBe(4);
    expect(change.tasks).toHaveLength(1);
    expect(change.tasks[0]).toMatchObject({ uid: "uid-n-1", key: "task-3", boardPos: 2, labels: ["ui"], artifacts: [] });
  });

  it("removes the tasks a disbanded team took with it", () => {
    const mixed = board([task({ id: "task-1" }), task({ id: "task-2", teamId: "team-2" })], 3);
    const kept = keepTeams(mixed, new Set(["team-1"]));
    const change = boardChange(mixed, kept, PLACE)!;
    expect(change.removed).toEqual(["uid-task-2"]);
    expect(change.tasks).toEqual([]);
  });

  it("writes a reorder of artifacts — they are in order, unlike labels", () => {
    const withTwo = changed(confirmed, "task-1", { kind: "artifacts", to: ["a", "b"] });
    const reordered = changed(withTwo, "task-1", { kind: "artifacts", to: ["b", "a"] });
    expect(boardChange(withTwo, reordered, PLACE)!.tasks[0].artifacts).toEqual(["b", "a"]);
    // A label set in another order is the same set.
    const labelled = withTasks(withTwo, withTwo.tasks.map((t) => (t.id === "task-1" ? { ...t, labels: ["x", "y"] } : t)));
    const relabelled = withTasks(labelled, labelled.tasks.map((t) => (t.id === "task-1" ? { ...t, labels: ["y", "x"] } : t)));
    expect(boardChange(labelled, relabelled, PLACE)!.tasks[0].labels).toBeNull();
  });

  it("writes a link put back with new metadata, and the ones taken away", () => {
    const linked = board([task({ id: "task-1" }), task({ id: "task-2" })], 3, [relation("blocks", "task-1", "task-2", 100, "lead")]);
    const reput = { ...linked, relations: [relation("blocks", "task-1", "task-2", 500, "user")] };
    expect(boardChange(linked, reput, PLACE)!.relationsPut).toEqual([
      { kind: "blocks", from: "uid-task-1", to: "uid-task-2", at: 500, by: "user" },
    ]);
    const unlinked = { ...linked, relations: [] };
    expect(boardChange(linked, unlinked, PLACE)!.relationsRemoved).toEqual([{ kind: "blocks", from: "uid-task-1", to: "uid-task-2" }]);
  });

  it("writes the same task objects moved to other places — the board's order is the domain's", () => {
    const swapped = { ...confirmed, tasks: [confirmed.tasks[1], confirmed.tasks[0]] };
    const change = boardChange(confirmed, swapped, PLACE)!;
    expect(change.tasks.map((t) => [t.uid, t.boardPos])).toEqual([
      ["uid-task-2", 0],
      ["uid-task-1", 1],
    ]);
  });

  it("writes a link whose time alone, or whose author alone, changed", () => {
    const linked = board([task({ id: "task-1" }), task({ id: "task-2" })], 3, [relation("blocks", "task-1", "task-2", 100, "lead")]);
    const later = { ...linked, relations: [relation("blocks", "task-1", "task-2", 500, "lead")] };
    expect(boardChange(linked, later, PLACE)!.relationsPut.map((r) => r.at)).toEqual([500]);
    const byOther = { ...linked, relations: [relation("blocks", "task-1", "task-2", 100, "user")] };
    expect(boardChange(linked, byOther, PLACE)!.relationsPut.map((r) => r.by)).toEqual(["user"]);
  });

  it("writes the counter moved on alone — a number handed out is never handed out again", () => {
    expect(boardChange(confirmed, { ...confirmed, nextId: 9 }, PLACE)).toMatchObject({ nextId: 9, tasks: [], relationsPut: [] });
  });

  it("writes a board rebuilt whole by value — every task, nothing wrong, history appended only", () => {
    const rebuilt = { ...confirmed, tasks: confirmed.tasks.map((t) => ({ ...t })) };
    const change = boardChange(confirmed, rebuilt, PLACE);
    // Rebuilt objects of equal value: each is written, with no history added.
    expect(change!.tasks.every((t) => t.comments.length === 0 && t.log.length === 0 && t.labels === null)).toBe(true);
  });

  it("writes a brief edit as a version and a log line", () => {
    const next = changed(confirmed, "task-1", { kind: "body", to: "new brief" });
    const write = boardChange(confirmed, next, PLACE)!.tasks[0];
    expect(write).toMatchObject({ body: "new brief", bodyV: 2, briefs: [{ v: 1, body: "" }] });
    expect(write.log).toEqual([{ seq: 0, at, author: "lead", field: "body", was: "1", now: "2" }]);
  });

  it("refuses a board that rewrote history the database holds", () => {
    const talked = changed(confirmed, "task-1", { kind: "comment", body: "said" });
    const rewritten = withTasks(talked, talked.tasks.map((t) => (t.id === "task-1" ? { ...t, comments: [{ ...t.comments[0], body: "unsaid" }] } : t)));
    expect(() => boardChange(talked, rewritten, PLACE)).toThrow(HistoryRewritten);
    const shortened = withTasks(talked, talked.tasks.map((t) => (t.id === "task-1" ? { ...t, comments: [] } : t)));
    expect(() => boardChange(talked, shortened, PLACE)).toThrow(HistoryRewritten);
  });

  it("refuses a log or a brief version rewritten under what the database holds, even with more appended", () => {
    const edited = changed(changed(confirmed, "task-1", { kind: "priority", to: "high" }), "task-1", { kind: "body", to: "second" });
    const rewrite = (patch: (t: Task) => Partial<Task>) => withTasks(edited, edited.tasks.map((t) => (t.id === "task-1" ? { ...t, ...patch(t) } : t)));
    const relogged = rewrite((t) => ({ log: [{ ...t.log[0], now: "low" }, ...t.log.slice(1), { ...t.log[0], at: at + 1 }] }));
    expect(() => boardChange(edited, relogged, PLACE)).toThrow(HistoryRewritten);
    const rebriefed = rewrite(() => ({ briefs: [{ v: 1, body: "not what it was" }, { v: 2, body: "second" }] }));
    expect(() => boardChange(edited, rebriefed, PLACE)).toThrow(HistoryRewritten);
  });
});

describe("the wire — a board into the store's shape and back", () => {
  const full: Task = {
    ...task({ id: "task-1", kind: "epic", assignee: "impl-1", labels: ["a", "b"], artifacts: ["z", "y"] }),
    body: "now",
    bodyV: 2,
    briefs: [{ v: 1, body: "then" }],
    comments: [{ n: 1, at: 5, from: "impl-1", body: "hi" }],
    log: [{ at: 6, from: "lead", field: "body", was: "1", now: "2" }],
  };
  const b = board([full, task({ id: "task-2" })], 3, [relation("blocks", "task-2", "task-1")]);

  it("round-trips field for field through the one validator", () => {
    const read = boardFromStored(storedFromBoard(b, PLACE), mintSequence());
    expect(read).toEqual({ ok: true, board: b, migrated: false, dropped: [] });
  });

  it("refuses what the domain would not accept — a task with no team, a word it does not know, a log out of place", () => {
    const stored = storedFromBoard(b, PLACE);
    const noTeam = { ...stored, tasks: [{ ...stored.tasks[0], teamId: null }, stored.tasks[1]] };
    expect(boardFromStored(noTeam, mintSequence())).toMatchObject({ ok: false, fault: { kind: "bad-task", id: "task-1", field: "teamId" } });
    const odd = { ...stored, tasks: [{ ...stored.tasks[0], status: "waiting" }, stored.tasks[1]] };
    expect(boardFromStored(odd, mintSequence())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "status" } });
    const gap = { ...stored, tasks: [{ ...stored.tasks[0], log: [{ ...stored.tasks[0].log[0], seq: 3 }] }, stored.tasks[1]] };
    expect(boardFromStored(gap, mintSequence())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "log[0] (out of place)" } });
  });
});
