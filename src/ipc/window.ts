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
