import { describe, expect, it } from "vitest";
import { END_SLACK_PX, atListFoot, followsChange, footAfter, holdWhileOff, pinAfterCommit, pinAfterScroll } from "./followEnd";

describe("atListFoot — where the view stands", () => {
  const box = (scrollTop: number) => ({ scrollTop, clientHeight: 200, scrollHeight: 600 });
  it("is at the foot at the end, and within a pixel's rounding of it — no further", () => {
    expect(atListFoot(box(400))).toBe(true);
    expect(atListFoot(box(400 - END_SLACK_PX))).toBe(true);
    expect(atListFoot(box(398.5))).toBe(true);
    expect(atListFoot(box(400 - END_SLACK_PX - 0.5))).toBe(false);
    expect(atListFoot(box(0))).toBe(false);
  });

  it("is at the foot for a list shorter than its box", () => {
    expect(atListFoot({ scrollTop: 0, clientHeight: 200, scrollHeight: 120 })).toBe(true);
  });
});

describe("followsChange — whether a change is followed to the foot", () => {
  const base = { on: true, changed: true, wasAtFoot: true, eased: false };
  it("follows a change of the rows when the view stood at the foot", () => {
    expect(followsChange(base)).toBe(true);
  });

  it("follows nothing for a list that does not follow, rows that did not change, a view away from the foot, or the person's own fold", () => {
    expect(followsChange({ ...base, on: false })).toBe(false);
    expect(followsChange({ ...base, changed: false })).toBe(false);
    expect(followsChange({ ...base, wasAtFoot: false })).toBe(false);
    expect(followsChange({ ...base, eased: true })).toBe(false);
  });
});

describe("the hold at the foot", () => {
  it("is taken by a follow, kept through commits, let go by the person's own fold", () => {
    expect(pinAfterCommit({ pinned: false, followed: true, eased: false })).toBe(true);
    expect(pinAfterCommit({ pinned: true, followed: false, eased: false })).toBe(true);
    expect(pinAfterCommit({ pinned: true, followed: false, eased: true })).toBe(false);
    expect(pinAfterCommit({ pinned: false, followed: false, eased: false })).toBe(false);
  });

  it("is let go when the person scrolls up, never by the list's own corrections down", () => {
    expect(pinAfterScroll({ pinned: true, scrollTop: 300, peak: 400 })).toEqual({ pinned: false, peak: 400 });
    expect(pinAfterScroll({ pinned: true, scrollTop: 420, peak: 400 })).toEqual({ pinned: true, peak: 420 });
    expect(pinAfterScroll({ pinned: true, scrollTop: 400 - END_SLACK_PX, peak: 400 })).toEqual({ pinned: true, peak: 400 });
    expect(pinAfterScroll({ pinned: false, scrollTop: 300, peak: 400 })).toEqual({ pinned: false, peak: 300 });
  });

  it("counts a slow scroll up from the lowest point held, not step by step", () => {
    let state = { pinned: true, peak: 400 };
    for (let top = 399; top >= 390; top -= 1) state = pinAfterScroll({ ...state, scrollTop: top });
    expect(state.pinned).toBe(false);
  });

  it("is dropped whole while the list does not follow, and kept while it does", () => {
    expect(holdWhileOff({ on: false, pinned: true, atFoot: true })).toEqual({ pinned: false, atFoot: false });
    expect(holdWhileOff({ on: true, pinned: true, atFoot: false })).toEqual({ pinned: true, atFoot: false });
  });

  it("counts the view at the foot while held, whatever the geometry says; otherwise as read", () => {
    expect(footAfter({ pinned: true, readAtFoot: false })).toBe(true);
    expect(footAfter({ pinned: false, readAtFoot: true })).toBe(true);
    expect(footAfter({ pinned: false, readAtFoot: false })).toBe(false);
  });
});
