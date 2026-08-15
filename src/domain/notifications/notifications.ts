import type { StatsTab } from "../usage/statsTabs";
import type { WorkspaceRef } from "../workspaceInstance";

/**
 * Notifications — the domain model and pure transforms behind the
 * notification center (`src/app/notificationCenter.ts`).
 *
 * A notification is a fact ("this pane's agent crashed", "an update is
 * available") with an origin; everything about HOW it reaches the user —
 * system banner vs the in-app center, suppression while the source is on
 * screen, spam control — is decided here as pure functions and executed by
 * the app-layer owner. Persistence: none — the list is runtime state, the
 * OS notification center keeps its own history.
 */

/** Where a notification came from. The origin drives navigation on click; the
 * host constructs it — a plugin cannot claim a pane origin or another
 * plugin's id. */

export type NotificationWorkspace = WorkspaceRef;

export type NotificationSource =
  | {
      type: "pane";
      workspace: NotificationWorkspace;
      paneId: string;
    }
  | {
      type: "plugin";
      pluginId: string;
      workspace?: NotificationWorkspace;
      dockTab?: string;
    }
  | { type: "app" }
  /** Opens the Statistics dialog, optionally on a named tab — achievement
   * unlocks land on the trophy case, not in Settings. Typed vocabulary:
   * renaming a tab breaks producers at compile time instead of silently
   * rerouting every deep link to Overview. */
  | { type: "stats"; tab?: StatsTab };

export type NotificationSeverity = "info" | "warning" | "error";

/** Shadows the DOM global of the same name on purpose (user decision) —
 * always import it; the shapes are incompatible enough that a missed import
 * fails to typecheck. */
export interface Notification {
  id: string;
  title: string;
  body?: string;
  /** Optional emoji glyph rendered in place of the severity dot — an
   * achievement badge carries its own icon into the bell. */
  icon?: string;
  severity: NotificationSeverity;
  source: NotificationSource;
  /** Replace-not-stack key (the Web Notifications `tag` semantics): a new
   * notification with the same tag replaces the previous one instead of
   * piling up — a flapping source holds one slot, not a column. */
  tag?: string;
  /** Epoch ms of creation. */
  at: number;
  /** Epoch ms when the user saw it in the center; unset = unread. */
  readAt?: number;
}

/** Center history cap — enough to scroll back a busy day, small enough to
 * never matter for memory. Oldest entries fall off first. */
export const NOTIFICATIONS_CAP = 200;

/** Minimum quiet time between system banners for the same flapping unit:
 * a source re-announcing faster than this keeps landing in the center but
 * stops hammering the OS. */
export const BANNER_COOLDOWN_MS = 5_000;

/**
 * The unit the banner cooldown lives on — decoupled from the list's
 * replace key on purpose. A tagged entry cools on its tag (a tagged series
 * is one voice); an UNTAGGED one cools on its source, so a pane emitting
 * a stream of separate history entries must not banner per entry. Keys are
 * opaque strings compared for identity only.
 */
export function bannerCooldownKey(
  notification: Pick<Notification, "tag" | "source">,
): string {
  if (notification.tag !== undefined) return `tag:${notification.tag}`;
  const { source } = notification;
  switch (source.type) {
    case "pane":
      // Pane ids are minted from one deck-wide sequence, unique for the
      // app's lifetime — the pane alone names the flapping unit.
      return `pane:${source.paneId}`;
    case "plugin":
      return `plugin:${source.pluginId}`;
    case "stats":
      return "stats";
    case "app":
      return "app";
  }
}

/**
 * Add `next` to the list (newest first). A same-tag predecessor is removed —
 * replaced, not stacked — and the newcomer arrives unread even if the old
 * entry had been read (it is NEWS again). The cap trims the oldest.
 */
export function addNotification(
  items: readonly Notification[],
  next: Notification,
): readonly Notification[] {
  const kept =
    next.tag === undefined
      ? items
      : items.filter((n) => n.tag !== next.tag);
  return [next, ...kept].slice(0, NOTIFICATIONS_CAP);
}

/** Mark one notification read. Returns the same array when nothing changed
 * (unknown id, already read) so subscribers skip a render. */
export function markRead(
  items: readonly Notification[],
  id: string,
  at: number,
): readonly Notification[] {
  const index = items.findIndex((n) => n.id === id && n.readAt === undefined);
  if (index === -1) return items;
  const next = [...items];
  next[index] = { ...items[index], readAt: at };
  return next;
}

/** Mark everything read. Same-reference no-op when nothing was unread. */
export function markAllRead(
  items: readonly Notification[],
  at: number,
): readonly Notification[] {
  if (!items.some((n) => n.readAt === undefined)) return items;
  return items.map((n) => (n.readAt === undefined ? { ...n, readAt: at } : n));
}

/** Remove the center's runtime history. Same-reference no-op when empty. */
export function clearNotifications(
  items: readonly Notification[],
): readonly Notification[] {
  return items.length === 0 ? items : [];
}

export function unreadCount(items: readonly Notification[]): number {
  return items.reduce((sum, n) => sum + (n.readAt === undefined ? 1 : 0), 0);
}

/** What the banner decision needs to know about the moment of arrival. */
export interface BannerContext {
  /** The app window has OS focus. */
  windowFocused: boolean;
  /** The notification's source is on screen right now (its workspace is
   * active and the pane is actually visible). Callers resolve this; pass
   * `false` when unknown — a spurious banner beats a swallowed one. */
  sourceVisible: boolean;
  /** When this tag last produced a banner, if ever. */
  lastBannerAt?: number;
  now: number;
}

/**
 * Whether a notification earns a system banner. Two suppressions only:
 * the source is literally on screen (the pane already shows its own card —
 * a banner would point at what the user is looking at), or the same tag
 * bannered within the cooldown window.
 */
export type BannerVerdict = "banner" | "seen-in-place" | "cooldown";

/** WHY a banner is or is not sent — the reason is part of the contract:
 * "seen-in-place" means the user is looking at the source surface, which
 * delivery accounting treats as delivered, while "cooldown" reached nobody
 * this time. Callers must consume the verdict, never re-derive a reason
 * from the context. */
export function bannerVerdict(ctx: BannerContext): BannerVerdict {
  if (ctx.windowFocused && ctx.sourceVisible) return "seen-in-place";
  if (
    ctx.lastBannerAt !== undefined &&
    ctx.now - ctx.lastBannerAt < BANNER_COOLDOWN_MS
  ) {
    return "cooldown";
  }
  return "banner";
}
