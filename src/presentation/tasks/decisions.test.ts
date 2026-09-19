import { describe, expect, it } from "vitest";
import { TASK_CAPS } from "../../domain/tasks";
import { board, task } from "../../domain/tasks/testSupport";
import { boardView } from "./boardView";
import {
  CLICK_AFTER_DRAG_MS,
  DRAG_THRESHOLD_PX,
  IDLE,
  armCard,
  clickDisbelieved,
  dropStateOf,
  ghostBox,
  moveCard,
  releaseCard,
} from "./cardDrag";
import { canCreateTask, canSendComment } from "./composerView";
import { DIALOG_WORDS, cardOf, escapeTarget, selectionAfterClick, toggledFold } from "./dialogState";
import { showTasksSocketHint } from "./settingsView";

const grip = { width: 200, offsetX: 20, offsetY: 10 };
const targets = new Set(["in-progress", "done"] as const);

describe("cardDrag", () => {
  it("a press is a click until it travels the threshold; then it is a drag with its targets, following the pointer", () => {
    const armed = armCard("task-1", 10, 10, grip);
    expect(moveCard(armed, 12, 12, () => targets)).toBe(armed);
    const dragging = moveCard(armed, 10 + DRAG_THRESHOLD_PX, 10, () => targets);
    expect(dragging).toMatchObject({ kind: "dragging", id: "task-1", x: 16, y: 10, targets });
    expect(moveCard(dragging, 100, 50, () => null)).toMatchObject({ kind: "dragging", x: 100, y: 50 });
    expect(ghostBox(dragging)).toEqual({ left: 16 - 20, top: 0, width: 200 });
    expect(ghostBox(armed)).toBeNull();
  });

  it("a card that vanished under the press cannot become a drag", () => {
    expect(moveCard(armCard("task-9", 0, 0, grip), 50, 50, () => null)).toBe(IDLE);
  });

  it("release over a target moves; over anything else, or from a mere press, nothing", () => {
    const dragging = moveCard(armCard("task-1", 0, 0, grip), 50, 50, () => targets);
    expect(releaseCard(dragging, "done")).toEqual({ state: IDLE, move: { id: "task-1", to: "done" }, dragged: true });
    expect(releaseCard(dragging, "review")).toEqual({ state: IDLE, move: null, dragged: true });
    expect(releaseCard(dragging, null)).toEqual({ state: IDLE, move: null, dragged: true });
    expect(releaseCard(armCard("task-1", 0, 0, grip), "done")).toEqual({ state: IDLE, move: null, dragged: false });
  });

  it("columns read their part in the drag; the click after a drag is disbelieved briefly", () => {
    const dragging = moveCard(armCard("task-1", 0, 0, grip), 50, 50, () => targets);
    expect(dropStateOf("done", dragging, null)).toBe("ok");
    expect(dropStateOf("done", dragging, "done")).toBe("over");
    expect(dropStateOf("review", dragging, "review")).toBe("no");
    expect(dropStateOf("done", IDLE, "done")).toBeNull();
    expect(clickDisbelieved(1_000, 1_000 + CLICK_AFTER_DRAG_MS - 1)).toBe(true);
    expect(clickDisbelieved(1_000, 1_000 + CLICK_AFTER_DRAG_MS)).toBe(false);
    expect(clickDisbelieved(null, 5)).toBe(false);
  });
});

describe("dialogState", () => {
  it("Escape peels the form, then the wide view, then the task, then the dialog", () => {
    expect(escapeTarget({ composing: true, wide: true, detailOpen: true })).toBe("form");
    expect(escapeTarget({ composing: false, wide: true, detailOpen: true })).toBe("wide");
    expect(escapeTarget({ composing: false, wide: false, detailOpen: true })).toBe("detail");
    expect(escapeTarget({ composing: false, wide: false, detailOpen: false })).toBe("dialog");
  });

  it("a click opens a card or puts the open one away; a fold press sets the opposite of what shows", () => {
    expect(selectionAfterClick(null, "task-1")).toBe("task-1");
    expect(selectionAfterClick("task-1", "task-1")).toBeNull();
    expect(selectionAfterClick("task-1", "task-2")).toBe("task-2");
    const b = board([task({ id: "task-1" }), task({ id: "task-2", status: "done" })]);
    const columns = boardView(b.tasks, b, { showCancelled: false, folds: new Map(), now: 0 });
    expect(toggledFold(columns, "done")).toBe(false); // folded by default → Show sets unfolded
    expect(toggledFold(columns, "todo")).toBe(true);
    expect(toggledFold(columns, "cancelled")).toBeNull();
    expect(cardOf(columns, "task-2")?.id).toBe("task-2");
    expect(cardOf(columns, "task-9")).toBeUndefined();
  });

  it("says the bar's and the head's words by state", () => {
    expect(DIALOG_WORDS.cancelledFilter(false)).toBe("Show cancelled");
    expect(DIALOG_WORDS.cancelledFilter(true)).toBe("Hide cancelled");
    expect(DIALOG_WORDS.cancelledFilterHint("board")).toBeNull();
    expect(DIALOG_WORDS.cancelledFilterHint("queues")).toContain("show on the board");
    expect(DIALOG_WORDS.wide(false)).toBe("Expand");
    expect(DIALOG_WORDS.wide(true)).toBe("Collapse");
    expect(DIALOG_WORDS.fold(true)).toBe("Show");
    expect(DIALOG_WORDS.poolCaption(true)).toContain("anyone on the team");
  });
});

describe("composer and form validity come from the domain", () => {
  it("a comment may be sent when the domain would accept it and nothing is in flight", () => {
    expect(canSendComment("  ", false)).toBe(false);
    expect(canSendComment("x", true)).toBe(false);
    expect(canSendComment("x", false)).toBe(true);
    expect(canSendComment("x".repeat(TASK_CAPS.commentMax + 1), false)).toBe(false);
  });

  it("a task may be created when the domain would accept its title", () => {
    expect(canCreateTask("")).toBe(false);
    expect(canCreateTask("  ")).toBe(false);
    expect(canCreateTask("x".repeat(TASK_CAPS.titleMax + 1))).toBe(false);
    expect(canCreateTask("Draft the skill")).toBe(true);
  });
});

describe("settingsView", () => {
  it("says the socket is down only while the feature is on and the socket is not", () => {
    expect(showTasksSocketHint(true, false)).toBe(true);
    expect(showTasksSocketHint(true, true)).toBe(false);
    expect(showTasksSocketHint(false, false)).toBe(false);
  });
});
