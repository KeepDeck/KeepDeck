import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";

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
 * OS, for the moments the web view hears nothing: a pointer leaving the
 * window fast through its edge sends the page no event at all. */
export async function pointerInWindow(): Promise<boolean> {
  const window = getCurrentWindow();
  const [pointer, origin, size] = await Promise.all([
    cursorPosition(),
    window.innerPosition(),
    window.innerSize(),
  ]);
  return within(pointer, origin, size);
}

/** A point inside a box, all in the same (physical) units. */
export function within(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  size: { width: number; height: number },
): boolean {
  return (
    point.x >= origin.x &&
    point.x < origin.x + size.width &&
    point.y >= origin.y &&
    point.y < origin.y + size.height
  );
}
