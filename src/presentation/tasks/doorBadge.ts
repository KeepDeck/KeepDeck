import {
  isTaskNotificationOf,
  unreadCount,
  type Notification,
  type NotificationWorkspace,
} from "../../domain/notifications";

/** What the door shows beside its glyph: the notification center's unread
 * task events for the workspace on screen — the same entries, and the same
 * read state, the bell holds. Nothing at zero, and nothing without a
 * workspace. */
export function tasksDoorBadge(
  items: readonly Notification[],
  workspace: NotificationWorkspace | null,
): number {
  return workspace === null ? 0 : unreadCount(items.filter((n) => isTaskNotificationOf(n, workspace)));
}
