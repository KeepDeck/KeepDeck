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

  it("returns to the same line under new output, the history having kept its head", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);

    expect(scroll.frameClosed(afterReprint(95))).toBe(30);
  });

  it("keeps its distance from the bottom when only the newest rows came back", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);

    expect(scroll.frameClosed(afterReprint(70))).toBe(10);
  });

  it("stops at the first line left when it read further back than what came back", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);

    expect(scroll.frameClosed(afterReprint(12))).toBe(0);
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

  it("owes no return once the user pressed a key, which xterm answers at the bottom", () => {
    const scroll = createRedrawScroll();
    scroll.frameOpened();
    scroll.historyCleared(scrolledUp);
    scroll.keyPressed();

    expect(scroll.frameClosed(afterReprint(90))).toBeUndefined();
  });

  it("returns when the write is parsed in a program that never opened a frame", () => {
    const scroll = createRedrawScroll();
    scroll.historyCleared(scrolledUp);

    expect(scroll.writeParsed(afterReprint(90))).toBe(30);
    expect(scroll.writeParsed({ viewportY: 30, baseY: 91 })).toBeUndefined();
  });
});
