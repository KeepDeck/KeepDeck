import { describe, expect, it, vi } from "vitest";
import {
  coverWindow,
  subscribeWindowCovers,
  windowCovered,
} from "./windowCover";

describe("windowCover", () => {
  it("reports covered only while a surface holds it", () => {
    expect(windowCovered()).toBe(false);

    const release = coverWindow();
    expect(windowCovered()).toBe(true);

    release();
    expect(windowCovered()).toBe(false);
  });

  it("stays covered until the LAST surface leaves", () => {
    // A file preview opened from a diff: two peeks, one window.
    const first = coverWindow();
    const second = coverWindow();

    first();
    expect(windowCovered()).toBe(true);

    second();
    expect(windowCovered()).toBe(false);
  });

  it("ignores a repeated release, so one surface cannot uncover another's", () => {
    const first = coverWindow();
    const second = coverWindow();

    // React may run a cleanup more than once; counting it twice would
    // uncover a window still under `second`.
    first();
    first();
    expect(windowCovered()).toBe(true);

    second();
    expect(windowCovered()).toBe(false);
  });

  it("notifies subscribers on cover and release, and stops at unsubscribe", () => {
    const seen = vi.fn();
    const stop = subscribeWindowCovers(seen);

    const release = coverWindow();
    expect(seen).toHaveBeenCalledTimes(1);
    release();
    expect(seen).toHaveBeenCalledTimes(2);

    stop();
    coverWindow()();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
