import { describe, expect, it } from "vitest";
import { decodeFaultText, migrationRefusalText, storeErrorText } from "./refusalText";

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

describe("the task database's refusals", () => {
  it("say why a move did not happen, or why the database cannot be used", () => {
    expect(migrationRefusalText({ kind: "failed", reason: "ws-2: not JSON" })).toBe("the boards could not move into the task database — ws-2: not JSON");
    expect(migrationRefusalText({ kind: "unusable", status: { kind: "damaged", detail: "page 3", backups: [] } })).toBe("the task database is damaged: page 3");
    expect(migrationRefusalText({ kind: "unusable", status: { kind: "missing", detail: "2 of its backups are still there", backups: [] } })).toBe(
      "the task database is missing, though 2 of its backups are still there",
    );
    expect(migrationRefusalText({ kind: "unusable", status: { kind: "tooNew", migration: "2099" } })).toContain("newer KeepDeck");
  });

  it("word every code — the retryable ones as what to wait for", () => {
    expect(storeErrorText({ code: "busy" })).toContain("another program");
    expect(storeErrorText({ code: "corrupt", detail: "page 3" })).toBe("the task database is damaged: page 3");
    expect(storeErrorText({ code: "missing", detail: "a copy of it set aside is still there" })).toBe(
      "the task database is missing, though a copy of it set aside is still there",
    );
    expect(storeErrorText({ code: "conflict", board: "b", rev: 3 })).toContain("read again");
  });
});
