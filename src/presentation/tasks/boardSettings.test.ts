import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, TASKS_FOLDED_EPICS_MAX, type TasksBoardSettings } from "../../domain/settings";
import { boardFolded, boardFoldedEpics, boardWithEpicFold, boardWithFold } from "./boardSettings";

const at = (folded: TasksBoardSettings["list"]["folded"], foldedEpics: readonly string[] = []): TasksBoardSettings => ({
  list: { folded, foldedEpics },
});

describe("the board's stored posture", () => {
  it("rests with the parked and the closed work folded, and every epic open", () => {
    expect(DEFAULT_SETTINGS.tasksBoard).toEqual({ list: { folded: ["backlog", "done", "cancelled"], foldedEpics: [] } });
    expect([...boardFolded(DEFAULT_SETTINGS.tasksBoard)]).toEqual(["backlog", "done", "cancelled"]);
    expect(boardFoldedEpics(DEFAULT_SETTINGS.tasksBoard).size).toBe(0);
  });

  it("folds and unfolds one group at a heading's toggle, keeping ladder order", () => {
    const opened = boardWithFold(at(["backlog", "done"]), "done");
    expect(opened.list.folded).toEqual(["backlog"]);
    // Folded again, it stands in its ladder place, not at the end.
    expect(boardWithFold(at(["done"]), "todo").list.folded).toEqual(["todo", "done"]);
    expect(boardWithFold(opened, "done").list.folded).toEqual(["backlog", "done"]);
  });

  it("folds an epic at its chevron as the most recent fold, and unfolds it, the groups' folds untouched", () => {
    const folded = boardWithEpicFold(at(["done"], ["u-1"]), "u-2");
    expect(folded.list).toEqual({ folded: ["done"], foldedEpics: ["u-1", "u-2"] });
    expect([...boardFoldedEpics(folded)]).toEqual(["u-1", "u-2"]);
    expect(boardWithEpicFold(folded, "u-1").list.foldedEpics).toEqual(["u-2"]);
  });

  it("remembers only the most recent folds, forgetting the least recent", () => {
    const full = Array.from({ length: TASKS_FOLDED_EPICS_MAX }, (_, i) => `u-${i}`);
    const next = boardWithEpicFold(at([], full), "u-new").list.foldedEpics;
    expect(next).toHaveLength(TASKS_FOLDED_EPICS_MAX);
    expect(next[0]).toBe("u-1");
    expect(next[next.length - 1]).toBe("u-new");
  });
});
