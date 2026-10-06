import { describe, expect, it } from "vitest";
import { CLICK_AFTER_DRAG_MS, DRAG_THRESHOLD_PX, IDLE, armRow, armsOn, clickDisbelieved, dropStateOf, ghostBox, moveRow, releaseRow } from "./rowDrag";

const grip = { width: 200, offsetX: 20, offsetY: 10 };
const targets = new Set(["in-progress", "done"] as const);

describe("rowDrag", () => {
  it("a press is a click until it travels the threshold; then it is a drag with its targets, following the pointer", () => {
    const armed = armRow("task-1", 10, 10, grip);
    expect(moveRow(armed, 12, 12, () => targets)).toBe(armed);
    const dragging = moveRow(armed, 10 + DRAG_THRESHOLD_PX, 10, () => targets);
    expect(dragging).toMatchObject({ kind: "dragging", id: "task-1", x: 16, y: 10, targets });
    expect(moveRow(dragging, 100, 50, () => null)).toMatchObject({ kind: "dragging", x: 100, y: 50 });
    expect(ghostBox(dragging)).toEqual({ left: 16 - 20, top: 0, width: 200 });
    expect(ghostBox(armed)).toBeNull();
  });

  it("a row that vanished under the press cannot become a drag", () => {
    expect(moveRow(armRow("task-9", 0, 0, grip), 50, 50, () => null)).toBe(IDLE);
  });

  it("release over a target moves; over anything else, or from a mere press, nothing", () => {
    const dragging = moveRow(armRow("task-1", 0, 0, grip), 50, 50, () => targets);
    expect(releaseRow(dragging, "done")).toEqual({ state: IDLE, move: { id: "task-1", to: "done" }, dragged: true });
    expect(releaseRow(dragging, "review")).toEqual({ state: IDLE, move: null, dragged: true });
    expect(releaseRow(dragging, null)).toEqual({ state: IDLE, move: null, dragged: true });
    expect(releaseRow(armRow("task-1", 0, 0, grip), "done")).toEqual({ state: IDLE, move: null, dragged: false });
  });

  it("groups read their part in the drag; the click after a drag is disbelieved briefly", () => {
    const dragging = moveRow(armRow("task-1", 0, 0, grip), 50, 50, () => targets);
    expect(dropStateOf("done", dragging, null)).toBe("ok");
    expect(dropStateOf("done", dragging, "done")).toBe("over");
    expect(dropStateOf("review", dragging, "review")).toBe("no");
    expect(dropStateOf("done", IDLE, "done")).toBeNull();
    expect(clickDisbelieved(1_000, 1_000 + CLICK_AFTER_DRAG_MS - 1)).toBe(true);
    expect(clickDisbelieved(1_000, 1_000 + CLICK_AFTER_DRAG_MS)).toBe(false);
    expect(clickDisbelieved(null, 5)).toBe(false);
    // Only the main button picks a row up.
    expect([armsOn(0), armsOn(1), armsOn(2)]).toEqual([true, false, false]);
  });
});
