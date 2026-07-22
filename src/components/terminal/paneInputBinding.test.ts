import { describe, expect, it, vi } from "vitest";
import { terminalPaneInput } from "./paneInputBinding";

describe("terminalPaneInput", () => {
  it("PASTE channel drives the terminal's term.paste, not the raw writer", () => {
    const paste = vi.fn();
    const writeRaw = vi.fn();
    const input = terminalPaneInput({ paste }, writeRaw);

    // terminalPaneInput always provides a paste channel.
    expect(input.paste).toBeDefined();
    input.paste!("fix the header");

    expect(paste).toHaveBeenCalledWith("fix the header");
    // A paste must not double-deliver through the raw PTY writer — that is the
    // original bug (bare raw stream dropped by bracketed-paste TUIs).
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
