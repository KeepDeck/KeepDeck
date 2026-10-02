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
 * at all. True where the OS cannot say. */
export function pointerInWindow(): Promise<boolean> {
  return invoke<boolean>("pointer_in_window");
}
