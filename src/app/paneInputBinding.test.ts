import { describe, expect, it, vi } from "vitest";
import { pasteToPane, registerPaneInput, subscribePaneComposerTouched } from "./paneInput";
import {
  handPasteWriter,
  registerTerminalPaneInput,
  terminalPaneInput,
} from "../components/terminal/paneInputBinding";
import { usePaneTerminal } from "./usePaneTerminal";
import { present } from "@keepdeck/plugin-api/testing";

describe("terminalPaneInput", () => {
  it("PASTE channel drives the terminal's term.paste, not the raw writer", () => {
    const paste = vi.fn();
    const writeRaw = vi.fn();
    const input = terminalPaneInput({ paste }, writeRaw);

    // terminalPaneInput always provides a paste channel.
    expect(input.paste).toBeDefined();
    present(input.paste, "the paste handler")("fix the header");

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
    const off = registerTerminalPaneInput({ registerInput: registerPaneInput }, "pane-glue", { paste }, writeRaw);

    // Drive it through the REAL registry, the way pane.write / deliverTask do.
    expect(pasteToPane("pane-glue", "fix the header")).toBe(true);
    expect(paste).toHaveBeenCalledWith("fix the header");
    // The registration glue must route paste onto term.paste — a regression
    // that inlines paste onto the raw writer here would fail this assertion.
    expect(writeRaw).not.toHaveBeenCalled();
    off();
  });
});

describe("handPasteWriter", () => {
  it("writes a person's paste into the terminal and says the composer was touched", () => {
    // ⌘V and the Edit menu reach the terminal as a paste, never as keys; the
    // words are in the composer all the same, and the mail's typed fallback
    // must know (task-589). Through the real port, so the whole path holds.
    const paste = vi.fn();
    const touched: string[] = [];
    const off = subscribePaneComposerTouched((paneId) => touched.push(paneId));
    handPasteWriter(usePaneTerminal(), "pane-7", { paste })("my draft");
    expect(paste).toHaveBeenCalledWith("my draft");
    expect(touched).toEqual(["pane-7"]);
    off();
  });
});
