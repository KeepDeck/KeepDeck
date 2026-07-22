import { describe, expect, it, vi } from "vitest";
import {
  paneInputReady,
  pasteToPane,
  registerPaneInput,
  registerPanePaste,
  writeToPane,
} from "./paneInput";

describe("pane input registry — TYPE channel (raw bytes)", () => {
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

describe("pane input registry — PASTE channel (xterm term.paste)", () => {
  it("routes a paste to the registered pane and reports success", () => {
    const paste = vi.fn();
    const off = registerPanePaste("pane-1", paste);
    expect(pasteToPane("pane-1", "hi")).toBe(true);
    expect(paste).toHaveBeenCalledWith("hi");
    off();
  });

  it("returns false for an unknown / unregistered pane", () => {
    expect(pasteToPane("pane-x", "y")).toBe(false);
    const off = registerPanePaste("pane-2", () => {});
    off();
    expect(pasteToPane("pane-2", "y")).toBe(false);
  });

  it("stale unregister doesn't drop a newer paste writer for the same id", () => {
    const first = vi.fn();
    const offFirst = registerPanePaste("pane-3", first);
    const second = vi.fn();
    registerPanePaste("pane-3", second);
    offFirst();
    expect(pasteToPane("pane-3", "z")).toBe(true);
    expect(second).toHaveBeenCalledWith("z");
    expect(first).not.toHaveBeenCalled();
  });
});

describe("pane input registry — channel independence", () => {
  it("the TYPE channel does not fire the PASTE writer, and vice versa", () => {
    const write = vi.fn();
    const paste = vi.fn();
    registerPaneInput("pane-shared", write);
    registerPanePaste("pane-shared", paste);

    // `paneInputReady` keys off the TYPE channel — both register together on
    // mount, so a live TYPE writer implies a live PASTE writer too.
    expect(paneInputReady("pane-shared")).toBe(true);

    expect(writeToPane("pane-shared", "raw")).toBe(true);
    expect(paste).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("raw");

    expect(pasteToPane("pane-shared", "pasted")).toBe(true);
    expect(paste).toHaveBeenCalledWith("pasted");
    // A paste must not double-deliver through the TYPE writer.
    expect(write).toHaveBeenCalledTimes(1);
  });
});
