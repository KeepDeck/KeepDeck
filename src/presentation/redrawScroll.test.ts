import { describe, expect, it } from "vitest";
import { createRedrawScroll } from "./redrawScroll";

const scrolledUp = { viewportY: 30, baseY: 90 };
/** What the wipe leaves: the view on the first line of whatever is printed. */
const afterReprint = (baseY: number) => ({ viewportY: 0, baseY });

describe("a view across a program redrawing its history", () => {
  it("returns to the line it stood on when the frame closes", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);

    expect(scroll.frameClosed(afterReprint(90))).toBe(30);
  });

  it("goes to the bottom when the history came back shorter than that line", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);

    expect(scroll.frameClosed(afterReprint(12))).toBe(12);
  });

  it("is left to follow the output when it stood at the bottom", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared({ viewportY: 90, baseY: 90 });

    expect(scroll.frameClosed(afterReprint(95))).toBeUndefined();
  });

  it("returns once: a later frame with no wipe leaves the view alone", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);
    scroll.frameClosed(afterReprint(90));

    expect(scroll.frameClosed({ viewportY: 30, baseY: 91 })).toBeUndefined();
  });

  it("keeps the first line through a second wipe before the return", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);
    scroll.historyCleared({ viewportY: 0, baseY: 5 });

    expect(scroll.frameClosed(afterReprint(90))).toBe(30);
  });

  it("waits for the frame to close in a program that draws frames, however its writes are parsed", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);

    expect(scroll.writeParsed(afterReprint(40))).toBeUndefined();
    expect(scroll.frameClosed(afterReprint(90))).toBe(30);
  });

  it("returns when the write is parsed in a program that never opened a frame", () => {
    const scroll = createRedrawScroll();
    scroll.historyCleared(scrolledUp);

    expect(scroll.writeParsed(afterReprint(90))).toBe(30);
    expect(scroll.writeParsed({ viewportY: 30, baseY: 91 })).toBeUndefined();
  });
});
