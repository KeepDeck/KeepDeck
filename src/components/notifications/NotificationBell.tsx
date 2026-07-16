import { useEffect, useReducer, useRef, useState } from "react";
import { BellIcon } from "@keepdeck/ui-kit/icons";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "../../app/notificationCenter";
import { useNotifications } from "../../app/useNotifications";
import { unreadCount, type Notification } from "../../domain/notifications";

interface NotificationBellProps {
  /** Navigate to the notification's source — the composition root resolves
   * each origin (pane / plugin / app). Called after the entry is marked read
   * and the panel closes. */
  onOpen(notification: Notification): void;
}

/** "5m", "2h", "3d" — the coarse age a glance needs; anything fresher than a
 * minute is "now". */
function age(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/**
 * The in-app notification center: a bell in the top bar with an unread badge,
 * opening an anchored panel listing the center's history (newest first).
 * Clicking an entry marks it read and navigates to its source; the bell
 * renders only in the modes that include the in-app channel (the caller
 * gates that).
 */
export function NotificationBell({ onOpen }: NotificationBellProps) {
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const unread = unreadCount(notifications);

  // The coarse ages ("5m") drift while the panel stays open — a slow tick
  // re-renders them; nothing else in the panel depends on wall time.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [open]);

  // Light-dismiss: any pointer press outside the bell (or Escape) closes the
  // panel — the same manners as a native menu.
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const now = Date.now();

  return (
    <span className="bell" ref={rootRef}>
      <button
        type="button"
        className="bar__icon bell__button"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : "Notifications"
        }
        aria-expanded={open}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="bell__badge" aria-hidden>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        // Not role="menu": these are plain buttons in a disclosure, with no
        // menuitem semantics or roving focus — a "menu" announcement would
        // promise interactions that aren't there.
        <div className="bell__panel" role="group" aria-label="Notifications">
          <div className="bell__head">
            <span className="bell__title">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                className="bell__clear"
                onClick={() => markAllNotificationsRead()}
              >
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="bell__empty">Nothing yet</div>
          ) : (
            <ul className="bell__list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`bell__item${n.readAt === undefined ? " bell__item--unread" : ""}`}
                    onClick={() => {
                      markNotificationRead(n.id);
                      setOpen(false);
                      onOpen(n);
                    }}
                  >
                    <span
                      className={`bell__dot bell__dot--${n.severity}`}
                      aria-hidden
                    />
                    <span className="bell__text">
                      <span className="bell__item-title">{n.title}</span>
                      {n.body !== undefined && (
                        <span className="bell__body">{n.body}</span>
                      )}
                    </span>
                    <span className="bell__age">{age(n.at, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}
