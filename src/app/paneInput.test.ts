import { describe, expect, it, vi } from "vitest";
import { registerPaneInput, writeToPane } from "./paneInput";

describe("pane input registry", () => {
  it("routes a write to the registered pane and reports success", () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", write);
    expect(writeToPane("pane-1", "hi")).toBe(true);
    expect(write).toHaveBeenCalledWith("hi");
    off();
  });

  it("returns false for an unknown / unregistered pane", () => {
    expect(writeToPane("pane-x", "y")).toBe(false);
    const off = registerPaneInput("pane-2", () => {});
    off();
    expect(writeToPane("pane-2", "y")).toBe(false);
  });

  it("stale unregister doesn't drop a newer writer for the same id", () => {
    const first = vi.fn();
    const offFirst = registerPaneInput("pane-3", first);
    const second = vi.fn();
    registerPaneInput("pane-3", second); // re-mount replaces the writer
    offFirst(); // stale cleanup must not drop the new writer
    expect(writeToPane("pane-3", "z")).toBe(true);
    expect(second).toHaveBeenCalledWith("z");
    expect(first).not.toHaveBeenCalled();
  });
});
