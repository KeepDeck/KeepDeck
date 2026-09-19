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
    const decoded = decodeBoard(encodeBoard(original));
    expect(decoded).toEqual({ ok: true, board: original });
    expect(decodeBoard(encodeBoard(EMPTY_BOARD))).toEqual({ ok: true, board: EMPTY_BOARD });
  });

  it("refuses the whole board when any task does not fit the vocabulary — and says which", () => {
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({ nextId: 2, tasks: [{ ...task({ id: "task-1" }), ...patch }] });
    for (const [patch, words] of [
      [{ status: "waiting" }, "status"],
      [{ priority: "urgent" }, "priority"],
      [{ assignee: 3 }, "assignee"],
      [{ blockedBy: [1] }, "blockedBy"],
      [{ comments: [{ n: 1 }] }, "comments"],
      [{ log: [{ at: 1, from: "x", field: "colour", was: null, now: null }] }, "log"],
      [{ id: "pane-1" }, "task id"],
    ] as const) {
      const result = decodeBoard(bad(patch));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(words);
    }
  });

  it("refuses non-JSON, a non-object, a bad counter and duplicate ids", () => {
    expect(decodeBoard("{").ok).toBe(false);
    expect(decodeBoard("[]").ok).toBe(false);
    expect(decodeBoard('{"nextId":0,"tasks":[]}').ok).toBe(false);
    const twice = JSON.stringify({ nextId: 3, tasks: [task({ id: "task-1" }), task({ id: "task-1" })] });
    const result = decodeBoard(twice);
    expect(!result.ok && result.error).toContain("duplicate");
  });
});
