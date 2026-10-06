import { describe, expect, it } from "vitest";
import { decodeFaultText, migrationRefusalText, refusalText, storeErrorText } from "./refusalText";

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
    expect(storeErrorText({ code: "inconsistent", board: "b1", detail: "task u1 has no current address" })).toBe(
      "board b1 does not hold together in the task database: task u1 has no current address",
    );
    expect(storeErrorText({ code: "missing", detail: "a copy of it set aside is still there" })).toBe(
      "the task database is missing, though a copy of it set aside is still there",
    );
    expect(storeErrorText({ code: "conflict", board: "b", rev: 3 })).toContain("read again");
    expect(storeErrorText({ code: "schemaTooNew", migration: "2099" })).toBe(
      "a newer KeepDeck wrote the task database (2099) — this one neither reads nor writes it",
    );
  });
});

describe("an epic's refusals", () => {
  it("say what the family rule refused and the one next step", () => {
    expect(refusalText({ kind: "epic-under-epic" })).toContain("one level");
    expect(refusalText({ kind: "not-an-epic", id: "task-2" })).toBe("task-2 is a task, not an epic — a task goes under an epic");
    expect(refusalText({ kind: "closed-epic", id: "task-1" })).toContain("reopen task-1 first");
    expect(refusalText({ kind: "cross-team-epic", id: "task-5" })).toContain("another team's board");
    expect(refusalText({ kind: "bad-create-kind", value: "story", allowed: ["task", "epic"] })).toBe('a task is made as task or epic, not "story"');
    expect(refusalText({ kind: "epic-has-open-work", open: [{ id: "task-2", status: "todo" }] })).toBe(
      "this epic still has open work — task-2 (to do); close or move them first",
    );
  });
});
