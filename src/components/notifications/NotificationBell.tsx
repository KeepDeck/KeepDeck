import { useEffect, useRef, useState } from "react";
import { BellIcon } from "@keepdeck/ui-kit/icons";
import type { NotificationCenter } from "../../app/notificationCenter";
import { useNotifications } from "../../app/useNotifications";
import { unreadCount, type Notification } from "../../domain/notifications";
import { formatAge, formatTimestamp } from "../../domain/usage";
import { isBehindModalLayer } from "../../ui/inertBackground";

interface NotificationBellProps {
  center: NotificationCenter;
  /** Navigate to the notification's source — the composition root resolves
   * each origin (pane / plugin / app). Called after the entry is marked read
   * and the panel closes. */
  onOpen(notification: Notification): void;
}

/**
 * The in-app notification center: a bell in the top bar with an unread badge,
 * opening an anchored panel listing the center's history (newest first).
 * Clicking an entry marks it read and navigates to its source; the bell
 * renders only in the modes that include the in-app channel (the caller
 * gates that).
 */
export function NotificationBell({ center, onOpen }: NotificationBellProps) {
  const notifications = useNotifications(center);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const unread = unreadCount(notifications);

  // Light-dismiss: any pointer press outside the bell (or Escape) closes the
  // panel — the same manners as a native menu. But a dialog can open over an
  // already-open panel without any pointer press (a menu accelerator, an MCP
  // command), and then the panel is background: these listeners are
  // capture-phase, so without the check one Escape would dismiss the panel
  // AND the dialog above it, and a click on the backdrop would close a panel
  // the user never touched. The panel is still here when the dialog goes.
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (isBehindModalLayer(rootRef.current)) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isBehindModalLayer(rootRef.current)) return;
      setOpen(false);
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
        ref={bellButtonRef}
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
            {notifications.length > 0 && (
              <span className="bell__actions">
                {unread > 0 && (
                  <button
                    type="button"
                    className="bell__action bell__mark-read"
                    onClick={() => center.markAllNotificationsRead()}
                  >
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  className="bell__action bell__clear-all"
                  onClick={() => {
                    bellButtonRef.current?.focus();
                    center.clearAllNotifications();
                  }}
                >
                  Clear all
                </button>
              </span>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="bell__empty" role="status" aria-live="polite">
              Nothing yet
            </div>
          ) : (
            <ul className="bell__list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`bell__item${n.readAt === undefined ? " bell__item--unread" : ""}`}
                    onClick={() => {
                      center.markNotificationRead(n.id);
                      setOpen(false);
                      onOpen(n);
                    }}
                  >
                    <span className="bell__leading" aria-hidden>
                      {n.icon !== undefined ? (
                        <span className="bell__icon">{n.icon}</span>
                      ) : n.severity !== "info" ? (
                        <span
                          className={`bell__dot bell__dot--${n.severity}`}
                        />
                      ) : null}
                    </span>
                    <span className="bell__text">
                      <span className="bell__item-title">{n.title}</span>
                      {n.body !== undefined && (
                        <span className="bell__body">{n.body}</span>
                      )}
                    </span>
                    <span
                      className="bell__age"
                      title={formatAge(n.at, now, "ago")}
                    >
                      {formatTimestamp(n.at, now)}
                    </span>
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
