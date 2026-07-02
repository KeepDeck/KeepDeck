import { invoke } from "@tauri-apps/api/core";
import {
  readText as pluginReadText,
  writeText as pluginWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

/**
 * The clipboard manager — the single module that touches the OS clipboard.
 * Every copy/paste surface (⌘C chord, Edit-menu copy, paste into a pane) goes
 * through these functions and so through the native plugin (Rust →
 * NSPasteboard), never WebKit's clipboard bridge: `navigator.clipboard` is
 * sandboxed in WKWebView, and one owned path keeps both directions
 * byte-identical and diagnosable in one place.
 */

/** Write text to the OS clipboard. */
export function writeText(text: string): Promise<void> {
  return pluginWriteText(text);
}

/**
 * Read the OS clipboard's text. Rejects when the clipboard holds no text —
 * callers decide what an empty read means (see `createPasteHandler`).
 */
export function readText(): Promise<string> {
  return pluginReadText();
}

/**
 * Save the OS clipboard's image to a temp PNG and resolve its absolute path —
 * how a pasteboard bitmap reaches a pane: a PTY only takes bytes, so the pane
 * pastes the file's path and image-aware CLIs read the file (same bridge as
 * an [F4] image drop). Resolves null when the clipboard holds no image.
 */
export function readImageTempPath(): Promise<string | null> {
  return invoke<string | null>("clipboard_image_to_temp");
}
