import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Subscribe to the main window gaining/losing OS focus. Resolves to the
 * unlisten fn. */
export function onWindowFocusChanged(
  handler: (focused: boolean) => void,
): Promise<() => void> {
  return getCurrentWindow().onFocusChanged(({ payload }) => handler(payload));
}

/** One-shot read of the window's current focus state. */
export function windowIsFocused(): Promise<boolean> {
  return getCurrentWindow().isFocused();
}

/** Whether the pointer is over the main window's content — asked of the
 * OS (Rust `pointer_in_window`, which reads the pointer and the window in
 * one coordinate space), for the moments the web view hears nothing: a
 * pointer leaving the window fast through its edge sends the page no event
 * at all — and not under another app's window there. Null where the OS
 * cannot say (no native answer on this platform). */
export function pointerInWindow(): Promise<boolean | null> {
  return invoke<boolean | null>("pointer_in_window");
}

/** The pointer on the main window's content: CSS pixels from its top-left
 * corner, and whether a mouse button is held. */
export interface PointerOnWindow {
  x: number;
  y: number;
  pressed: boolean;
}

/** Where the pointer is on the main window's content — asked of the OS
 * (Rust `pointer_on_window`) for a window coming to the front under a
 * pointer that has not moved, which the web view does not hear; and
 * whether a button is held, the click that brought it forward perhaps not
 * over yet. Null off the content (or under another app's window), or where
 * the OS cannot say. */
export function pointerOnWindow(): Promise<PointerOnWindow | null> {
  return invoke<PointerOnWindow | null>("pointer_on_window");
}
