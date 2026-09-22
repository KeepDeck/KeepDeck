import { useEffect } from "react";
import { isTaskNotificationOf, type Notification, type NotificationWorkspace } from "../../domain/notifications";

/**
 * Showing the person a workspace's boards answers what the notification
 * center said about them: while `shown` names a workspace whose boards are
 * on screen, its task notifications go read — once as the boards come up,
 * and again whenever another workspace's boards take their place. Events
 * that arrive while they stay up land read through the center's probe.
 */
export function useBoardSeen(
  shown: NotificationWorkspace | null,
  markReadWhere: (match: (n: Notification) => boolean) => void,
): void {
  const id = shown?.id;
  const instance = shown?.instance;
  useEffect(() => {
    if (id === undefined || instance === undefined) return;
    markReadWhere((n) => isTaskNotificationOf(n, { id, instance }));
  }, [id, instance, markReadWhere]);
}
