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

export function initWindowFocus(): Promise<void> {
  return Promise.all([
    windowIsFocused().then((f) => {
      focused = f;
    }),
    onWindowFocusChanged((f) => {
      focused = f;
    }),
  ])
    .then(() => undefined)
    .catch((e) => {
      // Without the bridge (tests, plain browser) stay on the default.
      log.warn("web:focus", `focus tracking unavailable: ${describeError(e)}`);
    });
}

export function isWindowFocused(): boolean {
  return focused;
}

/** Test hook: force a focus state without the IPC. */
export function setWindowFocusForTest(value: boolean): void {
  focused = value;
}
