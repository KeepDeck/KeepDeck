import {
  addNotification,
  markAllRead,
  markRead,
  bannerVerdict,
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
  /** Emoji glyph shown in place of the severity dot; see
   * [`Notification.icon`]. */
  icon?: string;
  /** Defaults to `info`. */
  severity?: NotificationSeverity;
  source: NotificationSource;
  /** Replace-not-stack key; see [`Notification.tag`]. */
  tag?: string;
}

let items: readonly Notification[] = [];
let seq = 0;
const listeners = new Set<() => void>();
/** Last banner time per tag — the cooldown's memory. Bounded: pane ids mint
 * forever, so without a cap this would grow for the app's lifetime. Insertion
 * order ≈ recency here (a tag re-banners via delete+set), so evicting the
 * first key sheds the coldest cooldown — at worst one long-dead tag gets a
 * redundant banner instead of a suppressed one. */
const lastBannerAt = new Map<string, number>();
const BANNER_TAGS_MAX = 512;
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
 * per-plugin mutes; decides the OS banner via the domain rule. Returns
 * whether a delivery channel ACCEPTED it — false means the user could not
 * have seen it (disabled or muted), which the achievements notifier uses to
 * defer its congratulated-set write instead of losing the award forever. */
export function notify(input: NotifyInput): boolean {
  const prefs = getSettings()?.notifications ?? DEFAULT_SETTINGS.notifications;
  if (!prefs.enabled) return false;
  if (
    input.source.type === "plugin" &&
    prefs.mutedPlugins.includes(input.source.pluginId)
  ) {
    return false;
  }
  const now = Date.now();
  seq += 1;
  const notification: Notification = {
    id: `ntf-${seq}`,
    title: input.title,
    body: input.body,
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
    severity: input.severity ?? "info",
    source: input.source,
    tag: input.tag,
    at: now,
  };
  // Honest delivery accounting: the return value states whether the user
  // was actually reached, channel by channel — callers that PERSIST a
  // delivery decision (the achievement notifier) depend on it.
  let delivered = false;
  if (prefs.mode !== "system") {
    items = addNotification(items, notification);
    emit();
    delivered = true;
  }
  if (prefs.mode !== "app") {
    const verdict = bannerVerdict({
      windowFocused: isWindowFocused(),
      sourceVisible: sourceVisible?.(notification.source) ?? false,
      now,
      // A miss is undefined — exactly the verdict's "never bannered".
      lastBannerAt:
        notification.tag !== undefined
          ? lastBannerAt.get(notification.tag)
          : undefined,
    });
    if (verdict === "seen-in-place") {
      // The user is looking at the source surface: the event announced
      // itself in place, so it counts as delivered — otherwise system mode
      // would re-banner an award the user watched land. Cooldown
      // suppression stays undelivered: nothing reached the user THIS time.
      delivered = true;
    }
    if (verdict === "banner") {
      if (notification.tag !== undefined) {
        lastBannerAt.delete(notification.tag); // re-set → back of the order
        lastBannerAt.set(notification.tag, now);
        if (lastBannerAt.size > BANNER_TAGS_MAX) {
          lastBannerAt.delete(lastBannerAt.keys().next().value as string);
        }
      }
      // The OS banner has no icon slot of ours — the emoji rides the title.
      sendSystemNotification(
        notification.icon !== undefined
          ? `${notification.icon} ${notification.title}`
          : notification.title,
        notification.body,
      );
      delivered = true;
    }
  }
  return delivered;
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
