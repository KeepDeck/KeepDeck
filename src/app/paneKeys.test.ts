import { describe, expect, it, vi } from "vitest";
import { reportPaneKey, subscribePaneKeys } from "./paneKeys";

describe("paneKeys", () => {
  it("hands every subscriber the pane and the bytes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribePaneKeys(first);
    const stopSecond = subscribePaneKeys(second);
    try {
      reportPaneKey("pane-1", "\r");
      expect(first).toHaveBeenCalledExactlyOnceWith("pane-1", "\r");
      expect(second).toHaveBeenCalledExactlyOnceWith("pane-1", "\r");
    } finally {
      stopFirst();
      stopSecond();
    }
  });

  it("stops at unsubscribe, and only for the one that left", () => {
    const staying = vi.fn();
    const leaving = vi.fn();
    const stopStaying = subscribePaneKeys(staying);
    subscribePaneKeys(leaving)();
    try {
      reportPaneKey("pane-1", "y");
      expect(leaving).not.toHaveBeenCalled();
      expect(staying).toHaveBeenCalledOnce();
    } finally {
      stopStaying();
    }
  });

  it("survives a subscriber that leaves mid-report", () => {
    // The dispatch iterates a COPY for this: a listener that unsubscribes
    // while being notified would otherwise mutate the set under the loop
    // and the next listener would be skipped.
    const later = vi.fn();
    let stopEarly = () => {};
    const early = vi.fn(() => stopEarly());
    stopEarly = subscribePaneKeys(early);
    const stopLater = subscribePaneKeys(later);
    try {
      reportPaneKey("pane-1", "n");
      expect(later).toHaveBeenCalledOnce();
      reportPaneKey("pane-1", "n");
      expect(early).toHaveBeenCalledOnce();
    } finally {
      stopLater();
    }
  });
});
