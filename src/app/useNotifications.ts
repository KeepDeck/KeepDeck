import { useSyncExternalStore } from "react";
import type { Notification } from "../domain/notifications";
import type { NotificationCenter } from "./notificationCenter";

const NONE: readonly Notification[] = [];
const subscribeNowhere = () => () => {};
const getNone = () => NONE;

/** The live notification list, newest first (React bridge over the
 * `notificationCenter` store). With no center — the in-app list is off —
 * it is the empty list, so a surface that shows the list only sometimes
 * can still call this unconditionally. */
export function useNotifications(
  center: NotificationCenter | null,
): readonly Notification[] {
  return useSyncExternalStore(
    center?.subscribeNotifications ?? subscribeNowhere,
    center?.getNotifications ?? getNone,
  );
}
