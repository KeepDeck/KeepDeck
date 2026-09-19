import { describe, expect, it } from "vitest";
import { decodeBoard, encodeBoard } from "./codec";
import { EMPTY_BOARD } from "./model";
import { board, task } from "./testSupport";

describe("board codec", () => {
  it("round-trips a board with comments and a log, field for field", () => {
    const original = board(
      [
        task({
          id: "task-1",
          status: "review",
          priority: "high",
          assignee: "impl-1",
          blockedBy: ["task-2"],
          artifacts: ["kd-tasks"],
          comments: [{ n: 1, at: 10, from: "lead", body: "go" }],
          log: [{ at: 9, from: "lead", field: "status", was: "todo", now: "in-progress" }],
        }),
        task({ id: "task-2", status: "done" }),
      ],
      7,
    );
    expect(decodeBoard(encodeBoard(original))).toEqual({ ok: true, board: original });
    expect(decodeBoard(encodeBoard(EMPTY_BOARD))).toEqual({ ok: true, board: EMPTY_BOARD });
  });

  it("refuses the whole board when any task does not fit the vocabulary — naming the task and the field", () => {
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({ nextId: 2, tasks: [{ ...task({ id: "task-1" }), ...patch }] });
    for (const [patch, field] of [
      [{ status: "waiting" }, "status"],
      [{ priority: "urgent" }, "priority"],
      [{ assignee: 3 }, "assignee"],
      [{ blockedBy: [1] }, "blockedBy"],
      [{ comments: [{ n: 1 }] }, "comments"],
      [{ log: [{ at: 1, from: "x", field: "colour", was: null, now: null }] }, "log"],
    ] as const) {
      expect(decodeBoard(bad(patch))).toEqual({ ok: false, fault: { kind: "bad-task", index: 0, id: "task-1", field } });
    }
    expect(decodeBoard(bad({ id: "pane-1" }))).toEqual({ ok: false, fault: { kind: "bad-task", index: 0, id: null, field: "id" } });
  });

  it("refuses non-JSON, a non-object, duplicate ids", () => {
    expect(decodeBoard("{")).toMatchObject({ ok: false, fault: { kind: "not-json" } });
    expect(decodeBoard("[]")).toEqual({ ok: false, fault: { kind: "not-object" } });
    expect(decodeBoard('{"nextId":1}')).toEqual({ ok: false, fault: { kind: "tasks-not-array" } });
    const twice = JSON.stringify({ nextId: 3, tasks: [task({ id: "task-1" }), task({ id: "task-1" })] });
    expect(decodeBoard(twice)).toEqual({ ok: false, fault: { kind: "duplicate-id", id: "task-1" } });
  });

  it("refuses a counter that would mint a twin, or is not a safe integer", () => {
    const withOne = (nextId: unknown) => JSON.stringify({ nextId, tasks: [task({ id: "task-7" })] });
    for (const nextId of [7, 1, 0, -1, 1.5, "8", undefined, 2 ** 53]) {
      expect(decodeBoard(withOne(nextId))).toEqual({ ok: false, fault: { kind: "bad-counter", atLeast: 8 } });
    }
    expect(decodeBoard(withOne(8)).ok).toBe(true);
    expect(decodeBoard(JSON.stringify({ nextId: 0, tasks: [] }))).toEqual({ ok: false, fault: { kind: "bad-counter", atLeast: 1 } });
  });
});
