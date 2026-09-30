import { useEffect, useRef, useState } from "react";
import { BellIcon } from "@keepdeck/ui-kit/icons";
import { Button } from "../../ui/Button";
import type { NotificationCenter } from "../../app/notificationCenter";
import { useNotifications } from "../../app/useNotifications";
import { unreadCount, type Notification } from "../../domain/notifications";
import { formatAge, formatTimestamp } from "../../domain/usage";
import {
  attentionTrigger,
  ATTENTION_WORDS,
  needsYouAge,
  type NeedsYouRow,
} from "../../presentation/needsYouView";
import { isBehindModalLayer } from "../../ui/inertBackground";

interface NotificationBellProps {
  /** The agents blocked on the person, across every workspace — shown
   * whatever the notification settings say, because it is the deck's live
   * state, not a feed. `onOpen` brings the agent forward. */
  needsYou: {
    rows: readonly NeedsYouRow[];
    onOpen(row: NeedsYouRow): void;
  };
  /** The in-app notification list, or null when notifications are off or
   * delegated to the system. */
  notifications: {
    center: NotificationCenter;
    /** Navigate to the notification's source — the composition root
     * resolves each origin (pane / plugin / app). Called after the entry is
     * marked read and the panel closes. */
    onOpen(notification: Notification): void;
  } | null;
}

/**
 * The notification bell. Always a bell — the count is its badge, never
 * words — and absent only with the in-app list off and nobody waiting. Its
 * anchored panel lists the agents that need the person first, then the
 * notification history (newest first).
 * Clicking an agent brings it forward; clicking an entry marks it read and
 * navigates to its source.
 */
export function NotificationBell({
  needsYou,
  notifications: feed,
}: NotificationBellProps) {
  const center = feed?.center ?? null;
  const notifications = useNotifications(center);
  const [open, setOpen] = useState(false);
  // The instant the panel opened: every age in it is worded against this
  // one reading, taken by the click that opened it — so the render stays
  // pure and a re-render while open (a new entry) does not re-age the rows.
  const [openedAt, setOpenedAt] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const unread = unreadCount(notifications);
  const trigger = attentionTrigger(needsYou.rows, center && { unread });
  const rows = needsYou.rows;

  // With the in-app list off, the bell goes when the last blocked agent is
  // answered, and takes its panel with it — it must not come back already
  // open.
  const shown = trigger !== null;
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

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

  const now = openedAt;

  if (!trigger) return null;

  return (
    <span className="bell" ref={rootRef}>
      <Button
        ref={bellButtonRef}
        variant="ghost"
        size="sm"
        className="bell__button"
        onClick={() => {
          if (!open) setOpenedAt(Date.now());
          setOpen(!open);
        }}
        label={trigger.label}
        expanded={open}
      >
        <BellIcon />
        {trigger.badge !== null && (
          <span className="bell__badge" aria-hidden>
            {trigger.badge}
          </span>
        )}
      </Button>
      {open && (
        // Not role="menu": these are plain buttons in a disclosure, with no
        // menuitem semantics or roving focus — a "menu" announcement would
        // promise interactions that aren't there.
        <div className="bell__panel" role="group" aria-label={trigger.label}>
          {rows.length > 0 && (
            <section className="bell__section" aria-label={ATTENTION_WORDS.needsYou}>
              <div className="bell__head">
                <span className="bell__title">{ATTENTION_WORDS.needsYou}</span>
              </div>
              <ul className="bell__list bell__list--needs">
                {rows.map((row) => (
                  <li key={row.paneId}>
                    <button
                      type="button"
                      className="bell__item bell__item--unread"
                      onClick={() => {
                        setOpen(false);
                        needsYou.onOpen(row);
                      }}
                    >
                      <span className="bell__leading" aria-hidden>
                        <span className={`bell__dot bell__dot--${row.tone}`} />
                      </span>
                      <span className="bell__text">
                        <span className="bell__item-title">{row.title}</span>
                        <span className="bell__body">
                          <span
                            className={`bell__reason bell__reason--${row.tone}`}
                          >
                            {row.label}
                          </span>
                          {" · "}
                          {row.where}
                        </span>
                      </span>
                      <span className="bell__age">{needsYouAge(row, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {feed && (
            <section
              className="bell__section bell__section--feed"
              aria-label={ATTENTION_WORDS.notifications}
            >
              <div className="bell__head">
                <span className="bell__title">{ATTENTION_WORDS.notifications}</span>
                {notifications.length > 0 && (
                  <span className="bell__actions">
                    {unread > 0 && (
                      <button
                        type="button"
                        className="bell__action bell__mark-read"
                        onClick={() => feed.center.markAllNotificationsRead()}
                      >
                        {ATTENTION_WORDS.markAllRead}
                      </button>
                    )}
                    <button
                      type="button"
                      className="bell__action bell__clear-all"
                      onClick={() => {
                        bellButtonRef.current?.focus();
                        feed.center.clearAllNotifications();
                      }}
                    >
                      {ATTENTION_WORDS.clearAll}
                    </button>
                  </span>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="bell__empty" role="status" aria-live="polite">
                  {ATTENTION_WORDS.feedEmpty}
                </div>
              ) : (
                <ul className="bell__list">
                  {notifications.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className={`bell__item${n.readAt === undefined ? " bell__item--unread" : ""}`}
                        onClick={() => {
                          feed.center.markNotificationRead(n.id);
                          setOpen(false);
                          feed.onOpen(n);
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
            </section>
          )}
        </div>
      )}
    </span>
  );
}
