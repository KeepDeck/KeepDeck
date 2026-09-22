import type { NotificationCenter } from "../../app/notificationCenter";
import { useNotifications } from "../../app/useNotifications";
import type { NotificationWorkspace } from "../../domain/notifications";
import { tasksDoorBadge } from "../../presentation/tasks";

/** The number on the Tasks door: the workspace's unread task notifications,
 * read from the one center the bell reads. */
export function useTasksUnread(center: NotificationCenter, workspace: NotificationWorkspace | null): number {
  return tasksDoorBadge(useNotifications(center), workspace);
}
