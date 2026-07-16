import { useSyncExternalStore } from "react";
import type { Notification } from "../domain/notifications";
import {
  getNotifications,
  subscribeNotifications,
} from "./notificationCenter";

/** The live notification list, newest first (React bridge over the
 * `notificationCenter` store). */
export function useNotifications(): readonly Notification[] {
  return useSyncExternalStore(subscribeNotifications, getNotifications);
}
