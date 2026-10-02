import { describe, expect, it } from "vitest";
import { REVEAL_AT_REST, stripReveal, type RevealEvent, type RevealState } from "./stripReveal";

const run = (events: RevealEvent["kind"][], from: RevealState = REVEAL_AT_REST) =>
  events.reduce((state, kind) => stripReveal(state, { kind } as RevealEvent), from);

describe("the strip's slide-out", () => {
  it("opens after a rest, and not at once", () => {
    expect(run(["enter"])).toMatchObject({ open: false, dwelling: true });
    expect(run(["enter", "dwelled"])).toMatchObject({ open: true, dwelling: false });
  });

  it("does not open under a press — a click or a hold-to-drag", () => {
    expect(run(["enter", "press", "dwelled"]).open).toBe(false);
  });

  it("rests again when the press lets go on the column — a press cancels the rest, not the opening", () => {
    expect(run(["enter", "press", "release"])).toMatchObject({ dwelling: true });
    expect(run(["enter", "press", "release", "dwelled"]).open).toBe(true);
    // Let go off the column, or on an open one: nothing to start.
    expect(run(["enter", "press", "leave", "release"]).dwelling).toBe(false);
    expect(run(["enter", "dwelled", "press", "release"])).toMatchObject({ open: true, dwelling: false });
  });

  it("shuts a grace after the pointer leaves, and stays if it comes back", () => {
    const open = run(["enter", "dwelled"]);
    expect(run(["leave"], open)).toMatchObject({ open: true, closing: true });
    expect(run(["leave", "graced"], open).open).toBe(false);
    expect(run(["leave", "enter", "graced"], open)).toMatchObject({ open: true, closing: false });
  });

  it("stays open through a click — a choice made in it is not a leave", () => {
    expect(run(["enter", "dwelled", "press", "release"]).open).toBe(true);
  });

  it("holds as it is through a drag, however far the pointer goes", () => {
    const dragging = run(["enter", "dwelled", "drag-start", "leave"]);
    expect(dragging).toMatchObject({ open: true, closing: false });
    const shutDrag = run(["enter", "press", "drag-start", "leave", "enter"]);
    expect(shutDrag).toMatchObject({ open: false, dwelling: false });
  });

  it("lets the pointer decide when a drag ends", () => {
    // Dropped on the column: an open strip stays; a shut one opens after
    // the rest, though no pointer entered.
    expect(run(["enter", "dwelled", "drag-start", "drag-end"])).toMatchObject({ open: true, closing: false });
    expect(run(["enter", "press", "drag-start", "drag-end"])).toMatchObject({ dwelling: true });
    // Dropped off it: an open strip shuts after the grace.
    expect(run(["enter", "dwelled", "drag-start", "leave", "drag-end"])).toMatchObject({ closing: true });
  });

  it("ignores a timer that is no longer running", () => {
    expect(run(["dwelled"])).toEqual(REVEAL_AT_REST);
    expect(run(["graced"])).toEqual(REVEAL_AT_REST);
  });
});
