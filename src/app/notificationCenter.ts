import {
  addNotification,
  markAllRead,
  markRead,
  shouldBanner,
  type Notification,
  type NotificationSeverity,
  type NotificationSource,
} from "../domain/notifications";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { sendSystemNotification } from "../ipc/notify";
import { getSettings } from "./settingsManager";
import { isWindowFocused } from "./windowFocus";

/**
 * The owner of the notification list — one per app, outside React, like
 * `settingsManager`. Everything that wants the user's attention funnels
 * through [`notify`]: internal producers (agent crash, spawn failure, an
 * available update) and — via the plugin host — `ctx.notify`. Delivery
 * honors the `notifications` settings: the list feeds the in-app bell, the
 * banner rule decides the OS side.
 *
 * The list is runtime state only; the OS notification center keeps its own
 * history, and ours ends with the process.
 */

export interface NotifyInput {
  title: string;
  body?: string;
  /** Defaults to `info`. */
  severity?: NotificationSeverity;
  source: NotificationSource;
  /** Replace-not-stack key; see [`Notification.tag`]. */
  tag?: string;
}

let items: readonly Notification[] = [];
let seq = 0;
const listeners = new Set<() => void>();
/** Last banner time per tag — the cooldown's memory. */
const lastBannerAt = new Map<string, number>();
/** Resolves whether a source is on screen right now; owned by the view root
 * (it knows the active workspace and pane visibility). Unset = not visible,
 * the direction that shows a possibly-redundant banner rather than
 * swallowing a needed one. */
let sourceVisible: ((source: NotificationSource) => boolean) | null = null;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function setSourceVisibilityProbe(
  probe: ((source: NotificationSource) => boolean) | null,
): void {
  sourceVisible = probe;
}

/** Post a notification. Honors the master switch, the delivery mode and
 * per-plugin mutes; decides the OS banner via the domain rule. */
export function notify(input: NotifyInput): void {
  const prefs = getSettings()?.notifications ?? DEFAULT_SETTINGS.notifications;
  if (!prefs.enabled) return;
  if (
    input.source.type === "plugin" &&
    prefs.mutedPlugins.includes(input.source.pluginId)
  ) {
    return;
  }
  const now = Date.now();
  seq += 1;
  const notification: Notification = {
    id: `ntf-${seq}`,
    title: input.title,
    severity: input.severity ?? "info",
    source: input.source,
    at: now,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
  };
  if (prefs.mode !== "system") {
    items = addNotification(items, notification);
    emit();
  }
  if (prefs.mode !== "app") {
    const allowed = shouldBanner({
      windowFocused: isWindowFocused(),
      sourceVisible: sourceVisible?.(notification.source) ?? false,
      now,
      ...(notification.tag !== undefined &&
      lastBannerAt.has(notification.tag)
        ? { lastBannerAt: lastBannerAt.get(notification.tag) }
        : {}),
    });
    if (allowed) {
      if (notification.tag !== undefined) {
        lastBannerAt.set(notification.tag, now);
      }
      sendSystemNotification(notification.title, notification.body);
    }
  }
}

/** The live list, newest first (stable between changes — the
 * `useSyncExternalStore` snapshot contract). */
export function getNotifications(): readonly Notification[] {
  return items;
}

export function markNotificationRead(id: string): void {
  const next = markRead(items, id, Date.now());
  if (next === items) return;
  items = next;
  emit();
}

export function markAllNotificationsRead(): void {
  const next = markAllRead(items, Date.now());
  if (next === items) return;
  items = next;
  emit();
}

/** Notify on every list change (the `useSyncExternalStore` contract). */
export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget the list, the cooldowns, the probe and every listener. */
export function resetNotificationCenter(): void {
  items = [];
  seq = 0;
  lastBannerAt.clear();
  sourceVisible = null;
  listeners.clear();
}
