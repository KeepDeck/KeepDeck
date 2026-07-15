import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { describeError, log } from "./log";

/**
 * System (OS) notifications — the thin wrapper over
 * `tauri-plugin-notification`. The OS's grant state is re-read on every use
 * (it is the OS's fact, not ours — the user can flip it in System Settings
 * mid-run, and a cached boolean would keep banners dead after a grant while
 * the settings page truthfully shows "allowed"). What IS cached is the
 * one-time PROMPT: macOS asks once per install, a denial is final until
 * System Settings, so repeating `requestPermission` is pure noise.
 */

let prompted: Promise<void> | null = null;

/** Whether the OS currently lets this app post notifications — a fresh,
 * pure read, NEVER prompts. The honest-status probe for settings UI. */
export function notificationPermissionGranted(): Promise<boolean> {
  return isPermissionGranted().catch((e) => {
    log.warn("web:notify", `permission probe failed: ${describeError(e)}`);
    return false;
  });
}

/** Whether the OS lets this app post notifications, asking (at most once per
 * run) if it currently doesn't. Re-reads the grant after the ask, so a
 * System-Settings flip is honored on the next call. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (await notificationPermissionGranted()) return true;
  prompted ??= requestPermission()
    .then(() => undefined)
    .catch((e) => {
      log.warn("web:notify", `permission request failed: ${describeError(e)}`);
    });
  await prompted;
  return notificationPermissionGranted();
}

/** Post a system banner. Fire-and-forget: a failure (or denied permission)
 * is logged, never thrown — the in-app center is the fallback record. */
export function sendSystemNotification(title: string, body?: string): void {
  void ensureNotificationPermission().then((granted) => {
    if (!granted) return;
    try {
      sendNotification(body === undefined ? { title } : { title, body });
    } catch (e) {
      log.warn("web:notify", `send failed: ${describeError(e)}`);
    }
  });
}

/** Test hook: forget that the run already prompted. */
export function resetNotifyIpc(): void {
  prompted = null;
}
