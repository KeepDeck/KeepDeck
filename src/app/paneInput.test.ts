import { describe, expect, it, vi } from "vitest";
import {
  paneInputReady,
  pasteToPane,
  registerPaneInput,
  writeToPane,
} from "./paneInput";

const entry = () => ({ write: vi.fn(), paste: vi.fn() });

describe("pane input registry", () => {
  it("routes `write` to the TYPE channel and `paste` to the PASTE channel", () => {
    const off = registerPaneInput("pane-1", entry());
    const e = entry();
    // Re-register with the one we assert against (registration is last-wins).
    registerPaneInput("pane-1", e);

    expect(writeToPane("pane-1", "raw")).toBe(true);
    expect(e.write).toHaveBeenCalledWith("raw");
    expect(e.paste).not.toHaveBeenCalled();

    expect(pasteToPane("pane-1", "pasted")).toBe(true);
    expect(e.paste).toHaveBeenCalledWith("pasted");
    // A paste must not double-deliver through write.
    expect(e.write).toHaveBeenCalledTimes(1);
    off();
  });

  it("returns false for an unknown / unregistered pane", () => {
    expect(writeToPane("pane-x", "y")).toBe(false);
    expect(pasteToPane("pane-x", "y")).toBe(false);
    const off = registerPaneInput("pane-2", entry());
    off();
    expect(writeToPane("pane-2", "y")).toBe(false);
    expect(pasteToPane("pane-2", "y")).toBe(false);
  });

  it("stale unregister doesn't drop a newer entry for the same id", () => {
    const offFirst = registerPaneInput("pane-3", entry());
    const second = entry();
    registerPaneInput("pane-3", second); // re-mount replaces the entry
    offFirst(); // stale cleanup must not drop the new entry
    expect(writeToPane("pane-3", "z")).toBe(true);
    expect(second.write).toHaveBeenCalledWith("z");
  });

  it("paneInputReady tracks the single entry, not a per-channel flag", () => {
    expect(paneInputReady("pane-4")).toBe(false);
    const off = registerPaneInput("pane-4", entry());
    expect(paneInputReady("pane-4")).toBe(true);
    // Ready gates both channels — there is no "ready channel != delivery
    // channel" gap, because one entry carries both.
    expect(pasteToPane("pane-4", "x")).toBe(true);
    off();
    expect(paneInputReady("pane-4")).toBe(false);
  });

  it("a TYPE-only entry accepts write but reports no paste channel", () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-5", { write });
    expect(writeToPane("pane-5", "raw")).toBe(true);
    expect(write).toHaveBeenCalledWith("raw");
    // No paste channel registered — pasteToPane refuses instead of silently
    // no-op'ing, so a caller can tell the pane cannot accept a paste.
    expect(pasteToPane("pane-5", "x")).toBe(false);
    off();
  });
});
