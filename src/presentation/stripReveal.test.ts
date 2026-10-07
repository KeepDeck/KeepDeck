import { describe, expect, it } from "vitest";
import {
  REVEAL_AT_REST,
  revealEventsOf,
  afterFocus,
  stripReveal,
  type RevealEvent,
  type RevealState,
} from "./stripReveal";

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
    // The drop is a let-go: its release and the drag's end come in either
    // order, and both orders rest the strip open.
    expect(run(["enter", "press", "drag-start", "release", "drag-end"])).toMatchObject({ dwelling: true });
    expect(run(["enter", "press", "drag-start", "drag-end", "release"])).toMatchObject({ dwelling: true });
    // Dropped off it: an open strip shuts after the grace.
    expect(run(["enter", "dwelled", "drag-start", "leave", "drag-end"])).toMatchObject({ closing: true });
  });

  it("takes the same fact twice as once — the wiring tells, the machine dedupes", () => {
    const open = run(["enter", "dwelled"]);
    expect(run(["enter"], open)).toBe(open);
    expect(run(["release"], open)).toBe(open);
    const away = run(["leave"], open);
    expect(run(["leave"], away)).toBe(away);
    const held = run(["press"], open);
    expect(run(["press"], held)).toBe(held);
  });

  it("does not rest open while a button is held from elsewhere — a selection or a drag crossing it", () => {
    expect(run(["press", "enter"])).toMatchObject({ inside: true, dwelling: false });
    expect(run(["press", "enter", "release"])).toMatchObject({ dwelling: true });
  });

  it("ignores a timer that is no longer running", () => {
    expect(run(["dwelled"])).toEqual(REVEAL_AT_REST);
    expect(run(["graced"])).toEqual(REVEAL_AT_REST);
  });
});

describe("revealEventsOf — what a pointer event tells", () => {
  it("says where the pointer is, by what is under it", () => {
    expect(revealEventsOf({ type: "move", inColumn: true, buttons: 0 })[0]).toEqual({ kind: "enter" });
    expect(revealEventsOf({ type: "out", inColumn: false, buttons: 0 })[0]).toEqual({ kind: "leave" });
  });

  it("presses on a down, lets go on an up or a cancel", () => {
    expect(revealEventsOf({ type: "down", inColumn: true, buttons: 1 })[1]).toEqual({ kind: "press" });
    expect(revealEventsOf({ type: "up", inColumn: true, buttons: 0 })[1]).toEqual({ kind: "release" });
    expect(revealEventsOf({ type: "cancel", inColumn: true, buttons: 0 })[1]).toEqual({ kind: "release" });
  });

  it("tells a pointer the OS found resting as the window came to the front: where it is, no button held", () => {
    expect(revealEventsOf({ type: "focus", inColumn: true, buttons: 0 })).toEqual([{ kind: "enter" }, { kind: "release" }]);
    expect(revealEventsOf({ type: "focus", inColumn: false, buttons: 1 })).toEqual([{ kind: "leave" }, { kind: "release" }]);
  });

  it("tells the buttons as they are on any other event — a let-go the page never heard is caught by the next move", () => {
    expect(revealEventsOf({ type: "move", inColumn: true, buttons: 0 })[1]).toEqual({ kind: "release" });
    expect(revealEventsOf({ type: "over", inColumn: true, buttons: 1 })[1]).toEqual({ kind: "press" });
  });
});

describe("afterFocus — the OS's answer after the window came to the front", () => {
  const on = (inColumn: boolean, pressed = false) => ({ inColumn, pressed });

  it("tells a pointer resting with no button held: where it is, nothing pressed", () => {
    expect(afterFocus({ point: on(true), heardFree: false, asksLeft: 3 })).toEqual({ tell: { type: "focus", inColumn: true, buttons: 0 } });
    expect(afterFocus({ point: on(false), heardFree: false, asksLeft: 3 })).toEqual({ tell: { type: "focus", inColumn: false, buttons: 0 } });
  });

  it("asks again while the button that brought the window forward is still held — and gives up when the asks run out", () => {
    expect(afterFocus({ point: on(true, true), heardFree: false, asksLeft: 1 })).toBe("ask-again");
    expect(afterFocus({ point: on(true, true), heardFree: false, asksLeft: 0 })).toBe("done");
  });

  it("is done off the window, or once the page has heard the pointer with no button held — it knows better", () => {
    expect(afterFocus({ point: null, heardFree: false, asksLeft: 3 })).toBe("done");
    expect(afterFocus({ point: on(true), heardFree: true, asksLeft: 3 })).toBe("done");
    expect(afterFocus({ point: on(true, true), heardFree: true, asksLeft: 3 })).toBe("done");
  });
});
