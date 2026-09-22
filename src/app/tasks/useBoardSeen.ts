import { useEffect, useSyncExternalStore } from "react";
import {
  isTaskNotificationOf,
  seenInPlace,
  type Notification,
  type NotificationWorkspace,
} from "../../domain/notifications";
import { isWindowFocused, subscribeWindowFocus } from "../windowFocus";

/**
 * Showing the person a workspace's boards answers what the notification
 * center said about them. Seen is the center's own rule (`seenInPlace`):
 * the boards on screen AND the window focused. So a workspace's task
 * notifications go read as its boards come up, when another workspace's
 * boards take their place, and when the person comes back to the window
 * with the boards still up — moves that landed unread while they were
 * away are in front of them now. Moves that arrive while they look land
 * read through the center's probe.
 */
export function useBoardSeen(
  shown: NotificationWorkspace | null,
  markReadWhere: (match: (n: Notification) => boolean) => void,
): void {
  const focused = useSyncExternalStore(subscribeWindowFocus, isWindowFocused);
  const seen = seenInPlace({ windowFocused: focused, sourceVisible: shown !== null });
  const id = seen ? shown?.id : undefined;
  const instance = seen ? shown?.instance : undefined;
  useEffect(() => {
    if (id === undefined || instance === undefined) return;
    markReadWhere((n) => isTaskNotificationOf(n, { id, instance }));
  }, [id, instance, markReadWhere]);
}
