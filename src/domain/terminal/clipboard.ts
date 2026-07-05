/**
 * Pure helpers for owning terminal copy ourselves.
 *
 * Why we can't rely on the native copy: with the canvas renderer xterm paints
 * text onto a `<canvas>`, and `.xterm` is `user-select: none`, so there is no
 * DOM text selection. On macOS/WKWebView the OS Cmd+C then copies the stale
 * hidden helper textarea instead of the visible selection — the "garbage" users
 * see. The fix (what every Tauri+xterm app converges on) is to intercept Cmd+C,
 * read xterm's own model-level `getSelection()`, and write it to the native
 * pasteboard ourselves. These two functions are the decision + text-shaping
 * pieces, kept pure so they're testable without xterm/DOM.
 */
import type { KeyEventLike } from "./keymap";

/** A key event plus its physical `code` (layout-independent). */
export interface CopyKeyEvent extends KeyEventLike {
  /** `KeyboardEvent.code`, e.g. "KeyC" — independent of keyboard layout. */
  code: string;
}

/**
 * True when the event is the copy chord we own: Cmd+C on keydown. We match the
 * physical `code` ("KeyC"), not `key`, so a non-Latin layout (e.g. Cyrillic,
 * where the C key yields "с") still copies. We deliberately do NOT claim Ctrl+C
 * — in a terminal that's SIGINT — so only the macOS Cmd copy is intercepted.
 */
export function isCopyChord(e: CopyKeyEvent): boolean {
  return (
    e.type === "keydown" &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    e.code === "KeyC"
  );
}

/**
 * Shape an xterm selection for the clipboard: strip per-line trailing whitespace
 * (cell padding xterm can include) without touching newlines or inner spacing.
 */
export function normalizeSelection(text: string): string {
  return text.replace(/[ \t]+$/gm, "");
}

/**
 * Extract the text of an OSC 52 clipboard WRITE request, or null when there is
 * nothing to write. `data` is what xterm hands an OSC handler — everything
 * after `52;`, i.e. `<selection>;<base64 payload>`. The selection chars
 * (c/p/s/0-7) are ignored: whichever selection the program targets, KeepDeck
 * has one system clipboard. Returns null for query requests (`?`) — answering
 * one would let any program running in a pane read the user's clipboard — and
 * for empty or undecodable payloads.
 */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep === -1) return null;
  const payload = data.slice(sep + 1);
  if (payload === "?") return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** The slice of a DOM paste/copy event the handlers need. */
export interface ClipboardEventLike {
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

/**
 * Build the pane's paste handler: own the DOM `paste` event (⌘V and the Edit
 * menu both end up here) and re-route it through the clipboard manager, so
 * paste reads the pasteboard over the same native path copy writes it.
 * Cancels WebKit's own insertion and stops xterm's built-in paste listener
 * (which would read WebKit's bridge) from running. Text wins; a text-less
 * clipboard falls back to `readImagePath` — the manager saves a pasteboard
 * image to a temp PNG and its PATH is pasted, the same bridge an [F4] image
 * drop uses (a PTY is a byte stream; a file path is how clipboard images
 * reach CLIs). No text and no image pastes nothing.
 */
export function createPasteHandler(
  readText: () => Promise<string>,
  readImagePath: () => Promise<string | null>,
  paste: (text: string) => void,
): (ev: ClipboardEventLike) => void {
  return (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    void readText()
      .catch(() => "")
      .then((text) => {
        if (text) {
          paste(text);
          return;
        }
        return readImagePath()
          .catch(() => null)
          .then((path) => {
            if (path) paste(path);
          });
      });
  };
}
