import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type TasksBoardSettings } from "../../domain/settings";
import { boardAfterDrop, boardFolded, boardWithFold, boardWithView } from "./boardSettings";

const at = (folded: TasksBoardSettings["list"]["folded"], view: TasksBoardSettings["view"] = "list"): TasksBoardSettings => ({
  view,
  list: { folded },
});

describe("the board's stored posture", () => {
  it("rests with the parked and the closed work folded, on the board", () => {
    expect(DEFAULT_SETTINGS.tasksBoard).toEqual({ view: "board", list: { folded: ["backlog", "done", "cancelled"] } });
    expect([...boardFolded(DEFAULT_SETTINGS.tasksBoard)]).toEqual(["backlog", "done", "cancelled"]);
  });

  it("folds and unfolds one group at a heading's toggle, keeping ladder order", () => {
    const opened = boardWithFold(at(["backlog", "done"]), "done");
    expect(opened.list.folded).toEqual(["backlog"]);
    // Folded again, it stands in its ladder place, not at the end.
    expect(boardWithFold(at(["done"]), "todo").list.folded).toEqual(["todo", "done"]);
    expect(boardWithFold(opened, "done").list.folded).toEqual(["backlog", "done"]);
  });

  it("picks a view and keeps the folds", () => {
    expect(boardWithView(at(["done"], "board"), "list")).toEqual(at(["done"], "list"));
  });

  it("opens the folded list group a drop's move lands in — nothing for an open one, or a drop on the board", () => {
    expect(boardAfterDrop(at(["done", "cancelled"]), "done", "list")).toEqual(at(["cancelled"]));
    expect(boardAfterDrop(at(["cancelled"]), "done", "list")).toBeNull();
    expect(boardAfterDrop(at(["done"], "board"), "done", "board")).toBeNull();
  });
});
