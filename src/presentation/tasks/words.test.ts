import { describe, expect, it } from "vitest";
import { blockerLinkWords, openWorkWords, boardBanner, fieldCount, readOnlyBanner, restoreView, unsavedBanner, personName, priorityMark, statusTone } from "./words";

describe("words", () => {
  it("names the person `you`, marks only the ends of the priority scale, and maps statuses onto the four hues", () => {
    expect(personName("user")).toBe("you");
    expect(personName("impl-1")).toBe("impl-1");
    expect([priorityMark("high"), priorityMark("normal"), priorityMark("low")]).toEqual(["HIGH", null, "LOW"]);
    expect(["in-progress", "review", "blocked", "done", "todo", "cancelled"].map((s) => statusTone(s as never))).toEqual([
      "working",
      "waiting",
      "failed",
      "done",
      "none",
      "none",
    ]);
  });
});

describe("fieldCount — a capped field's count", () => {
  it("says what is taken of how much there is, in the domain's measure, and marks it past the cap", () => {
    expect(fieldCount("title", "")).toEqual({ text: "0/120", className: "tasks__count" });
    expect(fieldCount("title", "Draft the skill")).toEqual({ text: "15/120", className: "tasks__count" });
    // As kept: a title's spaces at its ends do not count; a brief's do.
    expect(fieldCount("title", "  Draft  ").text).toBe("5/120");
    expect(fieldCount("body", "  Draft  ").text).toBe("9/8192");
    // Characters, not UTF-16 units: an emoji is one.
    expect(fieldCount("comment", "👍👍").text).toBe("2/4000");
    expect(fieldCount("title", "x".repeat(121))).toEqual({ text: "121/120", className: "tasks__count tasks__count--over" });
  });
});

describe("openWorkWords — an epic's open work in a phrase", () => {
  it("names each where it stands, and counts what is past the first five", () => {
    expect(openWorkWords([{ id: "task-3", status: "todo" }, { id: "task-5", status: "in-progress" }])).toBe("task-3 (to do), task-5 (in progress)");
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `task-${i + 1}`, status: "review" as const }));
    expect(openWorkWords(seven)).toBe("task-1 (review), task-2 (review), task-3 (review), task-4 (review), task-5 (review) and 2 more");
    expect(openWorkWords(seven.slice(0, 5))).not.toContain("more");
    expect(openWorkWords(seven.slice(0, 6))).toMatch(/ and 1 more$/);
  });
});

describe("blockerLinkWords — the links that keep a task on its team", () => {
  it("names what it waits on, then what waits on it", () => {
    expect(blockerLinkWords({ blockers: ["task-2"], dependants: ["task-3", "task-4"] })).toEqual([
      "it waits on task-2",
      "task-3 waits on it",
      "task-4 waits on it",
    ]);
  });
});

describe("restoreView — the way out of an unusable database", () => {
  const HOUR = 3_600_000;
  it("offers the newest verified backup, says how old it is and what a restore loses", () => {
    const view = restoreView({ kind: "damaged", backups: [10 * HOUR, 9 * HOUR] }, 12 * HOUR)!;
    expect(view.choice).toEqual({ kind: "backup", at: 10 * HOUR });
    expect(view.label).toBe("Restore the backup from 2h ago");
    expect(view.message).toContain("set aside, not deleted");
    expect(view.message).toContain("every board open in this session is written over it");
  });

  it("says a missing database is missing — nothing of it is set aside", () => {
    const view = restoreView({ kind: "missing", backups: [10 * HOUR] }, 12 * HOUR)!;
    expect(view.choice).toEqual({ kind: "backup", at: 10 * HOUR });
    expect(view.message).toMatch(/^The task database is missing\./);
    expect(view.message).not.toContain("set aside");
  });

  it("with no backup to restore, offers a new database — never with a backup there", () => {
    const view = restoreView({ kind: "damaged", backups: [] }, 0)!;
    expect(view.choice).toEqual({ kind: "empty" });
    expect(view.label).toBe("Start a new task database");
    expect(view.confirm).toBe("Start new");
    expect(view.message).toContain("Boards still in their files move into it");
    expect(view.message).toContain("any other board is not in it");
    expect(restoreView({ kind: "missing", backups: [] }, 0)!.message).toMatch(/^The task database is missing\. There is no backup/);
  });

  it("offers nothing when the database is usable", () => {
    expect(restoreView(null, 0)).toBeNull();
  });
});

describe("the board's banners — a disk lagging, a board that cannot be written", () => {
  it("speaks of the person's changes kept and retried, or of a board nothing can change, with the reason", () => {
    expect(unsavedBanner("disk full")).toBe("Changes not saved yet — disk full. The board keeps them and retries on its own.");
    expect(readOnlyBanner("the task database is damaged: page 3")).toBe(
      "The board is read-only — the task database is damaged: page 3. Nothing can be changed until this is resolved.",
    );
  });

  it("shows the read-only reason before any lag, and nothing when the board is fine", () => {
    expect(boardBanner({ unsaved: "disk full", readOnly: "damaged" })).toBe(readOnlyBanner("damaged"));
    expect(boardBanner({ unsaved: "disk full", readOnly: null })).toBe(unsavedBanner("disk full"));
    expect(boardBanner({ unsaved: null, readOnly: null })).toBeNull();
  });
});
