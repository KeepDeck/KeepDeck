import { describeError, log } from "../ipc/log";
import { onWindowFocusChanged, windowIsFocused } from "../ipc/window";

/**
 * Tracks whether the app window has OS focus — the one fact the banner rule
 * reads synchronously (`bannerVerdict` runs in the notify hot path, an async
 * probe there would race the event). Boot calls [`initWindowFocus`] once;
 * until it settles the window is assumed focused, which only suppresses
 * banners — the safe direction for a just-launched, foreground app.
 */

let focused = true;
const listeners = new Set<() => void>();

/** Record a focus fact and tell whoever watches — only on a change, so a
 * repeated OS event re-renders nothing. */
function setFocused(value: boolean): void {
  if (value === focused) return;
  focused = value;
  for (const listener of [...listeners]) listener();
}

export async function initWindowFocus(): Promise<void> {
  // Listener first, one-shot read second — a failing read must not discard
  // an already-attached listener (it lives for the app's lifetime; there is
  // deliberately no teardown).
  try {
    await onWindowFocusChanged(setFocused);
  } catch (e) {
    // Without the bridge (tests, plain browser) stay on the default.
    log.warn("web:focus", `focus tracking unavailable: ${describeError(e)}`);
    return;
  }
  try {
    setFocused(await windowIsFocused());
  } catch (e) {
    log.warn("web:focus", `focus read failed: ${describeError(e)}`);
  }
}

export function isWindowFocused(): boolean {
  return focused;
}

/** Hear every focus change — for a surface that acts when the person
 * comes back to what it shows (`useSyncExternalStore`'s contract). */
export function subscribeWindowFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: force a focus state without the IPC. */
export function setWindowFocusForTest(value: boolean): void {
  setFocused(value);
}
