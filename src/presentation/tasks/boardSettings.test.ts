import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type TasksBoardSettings } from "../../domain/settings";
import { boardFolded, boardWithFold } from "./boardSettings";

const at = (folded: TasksBoardSettings["list"]["folded"]): TasksBoardSettings => ({ list: { folded } });

describe("the board's stored posture", () => {
  it("rests with the parked and the closed work folded", () => {
    expect(DEFAULT_SETTINGS.tasksBoard).toEqual({ list: { folded: ["backlog", "done", "cancelled"] } });
    expect([...boardFolded(DEFAULT_SETTINGS.tasksBoard)]).toEqual(["backlog", "done", "cancelled"]);
  });

  it("folds and unfolds one group at a heading's toggle, keeping ladder order", () => {
    const opened = boardWithFold(at(["backlog", "done"]), "done");
    expect(opened.list.folded).toEqual(["backlog"]);
    // Folded again, it stands in its ladder place, not at the end.
    expect(boardWithFold(at(["done"]), "todo").list.folded).toEqual(["todo", "done"]);
    expect(boardWithFold(opened, "done").list.folded).toEqual(["backlog", "done"]);
  });
});
