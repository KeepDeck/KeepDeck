import { useSyncExternalStore } from "react";
import type { Notification } from "../domain/notifications";
import type { NotificationCenter } from "./notificationCenter";

/** The live notification list, newest first (React bridge over the
 * `notificationCenter` store). */
export function useNotifications(
  center: NotificationCenter,
): readonly Notification[] {
  return useSyncExternalStore(
    center.subscribeNotifications,
    center.getNotifications,
  );
}
