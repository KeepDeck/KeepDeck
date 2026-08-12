import {
  addNotification,
  clearNotifications,
  markAllRead,
  markRead,
  retractByTag,
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

export interface NotificationCenter {
  notify(input: NotifyInput): boolean;
  getNotifications(): readonly Notification[];
  subscribeNotifications(listener: () => void): () => void;
  retractNotification(tag: string): void;
  markNotificationRead(id: string): void;
  markAllNotificationsRead(): void;
  clearAllNotifications(): void;
  setSourceVisibilityProbe(
    probe: ((source: NotificationSource) => boolean) | null,
  ): void;
}

/** Last banner time per tag — the cooldown's memory. Bounded: pane ids mint
 * forever, so without a cap this would grow for the app's lifetime. Insertion
 * order ≈ recency here (a tag re-banners via delete+set), so evicting the
 * first key sheds the coldest cooldown — at worst one long-dead tag gets a
 * redundant banner instead of a suppressed one. */
const BANNER_TAGS_MAX = 512;

/** Build one app-lifetime notification owner. Tests and embedded surfaces use
 * fresh instances instead of mutating a process singleton through reset-only
 * production API. */
export function createNotificationCenter(): NotificationCenter {
  let items: readonly Notification[] = [];
  let seq = 0;
  const listeners = new Set<() => void>();
  const lastBannerAt = new Map<string, number>();
  /** Resolves whether a source is on screen right now; owned by the view root
   * (it knows the active workspace and pane visibility). Unset = not visible,
   * the direction that shows a possibly-redundant banner rather than
   * swallowing a needed one. */
  let sourceVisible: ((source: NotificationSource) => boolean) | null = null;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function setSourceVisibilityProbe(
    probe: ((source: NotificationSource) => boolean) | null,
  ): void {
    sourceVisible = probe;
  }

  /** Post a notification. Honors the master switch, the delivery mode and
   * per-plugin mutes; decides the OS banner via the domain rule. Returns
   * whether a delivery channel ACCEPTED it — false means the user could not
   * have seen it (disabled or muted), which the achievements notifier uses to
   * defer its congratulated-set write instead of losing the award forever. */
  function notify(input: NotifyInput): boolean {
    const prefs =
      getSettings()?.notifications ?? DEFAULT_SETTINGS.notifications;
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
  function getNotifications(): readonly Notification[] {
    return items;
  }

  /** Withdraw a tag's notification — the announced event has been ANSWERED,
   * not merely superseded (a newer event replaces via `notify`'s same-tag
   * rule; this is for waits the user resolved at the source, leaving nothing
   * to announce). The tag's banner cooldown deliberately SURVIVES: an
   * agent whose permissions auto-resolve flaps ask→answer→ask faster than a
   * human reads, and resetting the cooldown on every answer would let one
   * pane hammer the OS with a banner per tool call — the exact flood the
   * cooldown exists to stop. A genuinely new question inside the 5s window
   * still lands in the center; only its OS banner waits out the cooldown. */
  function retractNotification(tag: string): void {
    const next = retractByTag(items, tag);
    if (next === items) return;
    items = next;
    emit();
  }

  function markNotificationRead(id: string): void {
    const next = markRead(items, id, Date.now());
    if (next === items) return;
    items = next;
    emit();
  }

  function markAllNotificationsRead(): void {
    const next = markAllRead(items, Date.now());
    if (next === items) return;
    items = next;
    emit();
  }

  /** Empty only the in-app history. Banner cooldowns deliberately survive, just
   * as they do when a resolved event retracts its entry. */
  function clearAllNotifications(): void {
    const next = clearNotifications(items);
    if (next === items) return;
    items = next;
    emit();
  }

  /** Notify on every list change (the `useSyncExternalStore` contract). */
  function subscribeNotifications(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    notify,
    getNotifications,
    subscribeNotifications,
    retractNotification,
    markNotificationRead,
    markAllNotificationsRead,
    clearAllNotifications,
    setSourceVisibilityProbe,
  };
}

/** The production app's single notification owner. Named verb exports keep the
 * existing producer API narrow; consumers that need isolation inject an
 * independently created owner. */
export const notificationCenter = createNotificationCenter();
export const notify = notificationCenter.notify;
export const getNotifications = notificationCenter.getNotifications;
export const subscribeNotifications =
  notificationCenter.subscribeNotifications;
export const retractNotification = notificationCenter.retractNotification;
export const markNotificationRead = notificationCenter.markNotificationRead;
export const markAllNotificationsRead =
  notificationCenter.markAllNotificationsRead;
export const clearAllNotifications = notificationCenter.clearAllNotifications;
export const setSourceVisibilityProbe =
  notificationCenter.setSourceVisibilityProbe;
