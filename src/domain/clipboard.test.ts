import { describe, it, expect, vi } from "vitest";
import {
  createPasteHandler,
  isCopyChord,
  normalizeSelection,
  osc52Text,
  type ClipboardEventLike,
  type CopyKeyEvent,
} from "./clipboard";

const ev = (over: Partial<CopyKeyEvent> = {}): CopyKeyEvent => ({
  type: "keydown",
  key: "c",
  code: "KeyC",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: true,
  ...over,
});

describe("isCopyChord", () => {
  it("matches Cmd+C on keydown", () => {
    expect(isCopyChord(ev())).toBe(true);
  });

  it("matches the physical C key regardless of layout (Cyrillic 'с')", () => {
    expect(isCopyChord(ev({ key: "с" }))).toBe(true);
  });

  it("leaves Ctrl+C for SIGINT", () => {
    expect(isCopyChord(ev({ metaKey: false, ctrlKey: true }))).toBe(false);
  });

  it("ignores Cmd+Alt+C and Cmd+Ctrl+C", () => {
    expect(isCopyChord(ev({ altKey: true }))).toBe(false);
    expect(isCopyChord(ev({ ctrlKey: true }))).toBe(false);
  });

  it("only fires on keydown, not keyup/keypress", () => {
    expect(isCopyChord(ev({ type: "keyup" }))).toBe(false);
    expect(isCopyChord(ev({ type: "keypress" }))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isCopyChord(ev({ code: "KeyV" }))).toBe(false);
  });
});

describe("normalizeSelection", () => {
  it("strips per-line trailing whitespace, keeping newlines and inner spacing", () => {
    expect(normalizeSelection("abc   \nde f\t\n")).toBe("abc\nde f\n");
  });

  it("leaves clean text untouched", () => {
    expect(normalizeSelection("hello world")).toBe("hello world");
  });

  it("is a no-op on the empty string", () => {
    expect(normalizeSelection("")).toBe("");
  });
});

describe("osc52Text", () => {
  // "0L/RgNC40LLQtdGC" = base64 of the UTF-8 bytes of "привет".
  it("decodes a write request's base64 payload as UTF-8", () => {
    expect(osc52Text("c;0L/RgNC40LLQtdGC")).toBe("привет");
  });

  it("ignores which selection the program targets", () => {
    expect(osc52Text(";aGk=")).toBe("hi");
    expect(osc52Text("ps0;aGk=")).toBe("hi");
  });

  it("refuses to answer a query request", () => {
    expect(osc52Text("c;?")).toBeNull();
  });

  it("yields nothing for empty or undecodable payloads", () => {
    expect(osc52Text("c;")).toBeNull();
    expect(osc52Text("c;!!not-base64!!")).toBeNull();
    // "//4=" = bytes FF FE — not valid UTF-8.
    expect(osc52Text("c;//4=")).toBeNull();
    expect(osc52Text("no-separator")).toBeNull();
  });
});

describe("createPasteHandler", () => {
  const pasteEvent = (): ClipboardEventLike & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopImmediatePropagation: ReturnType<typeof vi.fn>;
  } => ({
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  });

  it("owns the event and pastes the clipboard text", async () => {
    const paste = vi.fn();
    const handler = createPasteHandler(() => Promise.resolve("привет"), paste);
    const ev = pasteEvent();

    handler(ev);
    // WebKit's default insertion and xterm's own paste listener must both be
    // cancelled synchronously, before the async read resolves.
    expect(ev.preventDefault).toHaveBeenCalledOnce();
    expect(ev.stopImmediatePropagation).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("привет"));
  });

  it("pastes nothing when the clipboard text is empty", async () => {
    const paste = vi.fn();
    const handler = createPasteHandler(() => Promise.resolve(""), paste);

    handler(pasteEvent());
    await Promise.resolve();
    expect(paste).not.toHaveBeenCalled();
  });

  it("pastes nothing when the clipboard holds no text (read rejects)", async () => {
    const paste = vi.fn();
    const handler = createPasteHandler(
      () => Promise.reject(new Error("no text")),
      paste,
    );
    const ev = pasteEvent();

    handler(ev);
    await Promise.resolve();
    await Promise.resolve();
    expect(paste).not.toHaveBeenCalled();
    // The event stays owned — a failed read must not fall back to WebKit.
    expect(ev.preventDefault).toHaveBeenCalledOnce();
  });
});
