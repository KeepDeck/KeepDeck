import { describe, expect, it } from "vitest";
import { decodeFaultText } from "./refusalText";

describe("decodeFaultText", () => {
  it("names a field the build does not know, quoted, so it can be found", () => {
    expect(decodeFaultText({ kind: "unknown-field", field: "colour" })).toBe(
      'board.json: a field this KeepDeck does not know — "colour"',
    );
  });

  it("names the task and the field a task did not fit with", () => {
    expect(decodeFaultText({ kind: "bad-task", index: 2, id: "task-3", field: 'comments[0]: unknown field "edited"' })).toBe(
      'board.json: tasks[2] (task-3): comments[0]: unknown field "edited" does not fit',
    );
  });
});
