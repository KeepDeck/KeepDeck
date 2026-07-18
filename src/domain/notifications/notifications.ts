import type { WorkspaceInstance } from "../workspaceInstance";

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

/** Where a notification came from. The origin drives navigation on click and
 * per-workspace unread badges; the host constructs it — a plugin cannot claim
 * a pane origin or another plugin's id. */

export interface NotificationWorkspace {
  id: string;
  /** `null` means a plugin named a workspace that did not exist at delivery. */
  instance: WorkspaceInstance | null;
}

export type NotificationSource =
  | {
      type: "pane";
      workspace: NotificationWorkspace & { instance: WorkspaceInstance };
      paneId: string;
    }
  | {
      type: "plugin";
      pluginId: string;
      workspace?: NotificationWorkspace;
      dockTab?: string;
    }
  | { type: "app" };

export type NotificationSeverity = "info" | "warning" | "error";

/** Shadows the DOM global of the same name on purpose (user decision) —
 * always import it; the shapes are incompatible enough that a missed import
 * fails to typecheck. */
export interface Notification {
  id: string;
  title: string;
  body?: string;
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

/** Minimum quiet time between system banners for the same tag: a source
 * flapping faster than this keeps updating the center entry but stops
 * hammering the OS. */
export const BANNER_COOLDOWN_MS = 5_000;

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

export function unreadCount(items: readonly Notification[]): number {
  return items.reduce((sum, n) => sum + (n.readAt === undefined ? 1 : 0), 0);
}

/** Unread tallies per workspace, for the rail dots. A notification counts
 * toward the workspace its source names; `app`-scoped ones belong to no
 * workspace and only feed the bell total. */
export function unreadByWorkspace(
  items: readonly Notification[],
): Map<WorkspaceInstance, number> {
  const counts = new Map<WorkspaceInstance, number>();
  for (const n of items) {
    if (n.readAt !== undefined) continue;
    const workspace = n.source.type === "app" ? undefined : n.source.workspace;
    if (!workspace || workspace.instance === null) continue;
    counts.set(workspace.instance, (counts.get(workspace.instance) ?? 0) + 1);
  }
  return counts;
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
export function shouldBanner(ctx: BannerContext): boolean {
  if (ctx.windowFocused && ctx.sourceVisible) return false;
  if (
    ctx.lastBannerAt !== undefined &&
    ctx.now - ctx.lastBannerAt < BANNER_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}
