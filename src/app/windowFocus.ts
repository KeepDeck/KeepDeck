import { describeError, log } from "../ipc/log";
import { onWindowFocusChanged, windowIsFocused } from "../ipc/window";

/**
 * Tracks whether the app window has OS focus — the one fact the banner rule
 * reads synchronously (`shouldBanner` runs in the notify hot path, an async
 * probe there would race the event). Boot calls [`initWindowFocus`] once;
 * until it settles the window is assumed focused, which only suppresses
 * banners — the safe direction for a just-launched, foreground app.
 */

let focused = true;

export async function initWindowFocus(): Promise<void> {
  // Listener first, one-shot read second — a failing read must not discard
  // an already-attached listener (it lives for the app's lifetime; there is
  // deliberately no teardown).
  try {
    await onWindowFocusChanged((f) => {
      focused = f;
    });
  } catch (e) {
    // Without the bridge (tests, plain browser) stay on the default.
    log.warn("web:focus", `focus tracking unavailable: ${describeError(e)}`);
    return;
  }
  try {
    focused = await windowIsFocused();
  } catch (e) {
    log.warn("web:focus", `focus read failed: ${describeError(e)}`);
  }
}

export function isWindowFocused(): boolean {
  return focused;
}

/** Test hook: force a focus state without the IPC. */
export function setWindowFocusForTest(value: boolean): void {
  focused = value;
}
