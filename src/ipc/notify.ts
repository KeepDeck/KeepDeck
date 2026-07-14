import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { describeError, log } from "./log";

/**
 * System (OS) notifications — the thin wrapper over
 * `tauri-plugin-notification`. Permission is resolved lazily on the first
 * send and remembered: macOS prompts once per install; a denial is final
 * until the user flips it in System Settings, so we stop asking and just
 * report the state (the settings section shows it).
 */

let permission: Promise<boolean> | null = null;

/** Whether the OS lets this app post notifications, asking once if the user
 * was never prompted. Cached for the app's lifetime. */
export function ensureNotificationPermission(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    const outcome = await requestPermission();
    return outcome === "granted";
  })().catch((e) => {
    log.warn("web:notify", `permission probe failed: ${describeError(e)}`);
    return false;
  });
  return permission;
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

/** Test hook: forget the cached permission probe. */
export function resetNotifyIpc(): void {
  permission = null;
}
