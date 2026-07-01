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
