import { describe, expect, it, vi } from "vitest";
import { pasteToPane } from "../../app/paneInput";
import {
  registerTerminalPaneInput,
  terminalPaneInput,
} from "./paneInputBinding";

describe("terminalPaneInput", () => {
  it("PASTE channel drives the terminal's term.paste, not the raw writer", () => {
    const paste = vi.fn();
    const writeRaw = vi.fn();
    const input = terminalPaneInput({ paste }, writeRaw);

    // terminalPaneInput always provides a paste channel.
    expect(input.paste).toBeDefined();
    input.paste!("fix the header");

    expect(paste).toHaveBeenCalledWith("fix the header");
    // A paste must not double-deliver through the raw PTY writer — the PASTE
    // channel exists so a paste keeps xterm's bracketed framing; the TYPE/raw
    // channel is for keystroke-style input (see pane.write mode:"type").
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it("TYPE channel drives the raw PTY writer", () => {
    const paste = vi.fn();
    const writeRaw = vi.fn();
    const input = terminalPaneInput({ paste }, writeRaw);

    input.write("/x/shot.png");

    expect(writeRaw).toHaveBeenCalledWith("/x/shot.png");
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("registerTerminalPaneInput (the TerminalPane call-site glue)", () => {
  it("wires the PASTE channel end-to-end through the registry: pasteToPane drives term.paste, not the raw writer", () => {
    const paste = vi.fn();
    const writeRaw = vi.fn();
    const off = registerTerminalPaneInput("pane-glue", { paste }, writeRaw);

    // Drive it through the REAL registry, the way pane.write / deliverTask do.
    expect(pasteToPane("pane-glue", "fix the header")).toBe(true);
    expect(paste).toHaveBeenCalledWith("fix the header");
    // The registration glue must route paste onto term.paste — a regression
    // that inlines paste onto the raw writer here would fail this assertion.
    expect(writeRaw).not.toHaveBeenCalled();
    off();
  });
});
