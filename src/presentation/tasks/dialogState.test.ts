import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import { IDLE, armRow, dragOutlived, escapeDrag, moveRow, taskOnScreen } from "./rowDrag";
import { DIALOG_WORDS, escapeTarget, selectionAfterClick, teamControlView } from "./dialogState";

describe("dialogState", () => {
  it("Escape peels the form, then the wide view, then the task, then the dialog", () => {
    expect(escapeTarget({ composing: true, wide: true, detailOpen: true })).toBe("form");
    expect(escapeTarget({ composing: false, wide: true, detailOpen: true })).toBe("wide");
    expect(escapeTarget({ composing: false, wide: false, detailOpen: true })).toBe("detail");
    expect(escapeTarget({ composing: false, wide: false, detailOpen: false })).toBe("dialog");
    // A drag is peeled before any layer: it goes back, and nothing closes.
    expect(escapeDrag(armRow("task-1", 0, 0, { width: 1, offsetX: 0, offsetY: 0 }))).toEqual(IDLE);
    expect(escapeDrag(IDLE)).toBeNull();
  });

  it("holds a task on screen only while it is on the board and the team shown; a drag that outlived it ends", () => {
    const b = board([task({ id: "task-1" }), task({ id: "task-2", teamId: "team-2" })]);
    expect(taskOnScreen(b, "task-1", "team-1")?.id).toBe("task-1");
    expect(taskOnScreen(b, "task-9", "team-1")).toBeNull();
    // Moved to another team mid-drag: no task to drop on this board.
    expect(taskOnScreen(b, "task-2", "team-1")).toBeNull();
    expect(taskOnScreen(null, "task-1", "team-1")).toBeNull();
    expect(taskOnScreen(b, null, "team-1")).toBeNull();
    const flying = moveRow(armRow("task-1", 0, 0, { width: 1, offsetX: 0, offsetY: 0 }), 50, 50, () => new Set());
    expect(dragOutlived(flying, null)).toEqual(IDLE);
    expect(dragOutlived(flying, { id: "task-1" })).toBeNull();
    expect(dragOutlived(IDLE, null)).toBeNull();
  });

  it("a click opens a card or puts the open one away", () => {
    expect(selectionAfterClick(null, "task-1")).toBe("task-1");
    expect(selectionAfterClick("task-1", "task-1")).toBeNull();
    expect(selectionAfterClick("task-1", "task-2")).toBe("task-2");
  });

  it("the team control is a pick among several, the one team's name as a word, or nothing", () => {
    const teams = [
      { id: "team-1", name: "Tasks" },
      { id: "team-2", name: "Docs" },
    ];
    expect(teamControlView(teams, "team-2")).toEqual({
      kind: "pick",
      options: [
        { value: "team-1", label: "Tasks" },
        { value: "team-2", label: "Docs" },
      ],
      value: "team-2",
    });
    expect(teamControlView(teams, null)).toEqual({ kind: "none" });
    expect(teamControlView([teams[0]], "team-1")).toEqual({ kind: "word", name: "Tasks" });
    expect(teamControlView([], null)).toEqual({ kind: "none" });
  });

  it("says the bar's and the head's words by state", () => {
    expect([DIALOG_WORDS.title, DIALOG_WORDS.team, DIALOG_WORDS.newTask, DIALOG_WORDS.close]).toEqual(["Tasks", "Team", "+ Task", "Close tasks"]);
    expect(DIALOG_WORDS.wide(false)).toBe("Expand");
    expect(DIALOG_WORDS.wide(true)).toBe("Collapse");
  });
});
