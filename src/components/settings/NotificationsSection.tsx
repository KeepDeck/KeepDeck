import { useEffect, useState } from "react";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import {
  DEFAULT_SETTINGS,
  NOTIFICATION_MODES,
  type NotificationsMode,
} from "../../domain/settings";
import {
  ensureNotificationPermission,
  notificationPermissionGranted,
} from "../../ipc/notify";

/** Label + one-line explanation for each delivery mode, in picker order. */
const MODE_OPTIONS: Record<NotificationsMode, { label: string; hint: string }> = {
  "system-and-app": {
    label: "System + in-app",
    hint: "OS banners, plus the bell with history and navigation.",
  },
  system: {
    label: "System only",
    hint: "OS banners only; the bell disappears from the top bar.",
  },
  app: {
    label: "In-app only",
    hint: "Everything stays in the bell; the OS is never touched.",
  },
};

/**
 * Notification preferences: the master switch and the delivery mode. The OS
 * permission state renders as an honest status line — in the system-only mode
 * a denied permission means no notifications at all, and flipping it back on
 * lives in System Settings, not here.
 */
export function NotificationsSection() {
  const settings = useSettings();
  const prefs = settings?.notifications ?? DEFAULT_SETTINGS.notifications;
  // Three states: unknown (probing), granted, not granted. The mount probe is
  // a pure READ — every settings section stays mounted whenever the dialog
  // opens, so prompting here would ambush a user who came for another page
  // (and would touch the OS even in the app-only mode). The actual prompt
  // fires only from the explicit Allow button below, or lazily on the first
  // real banner.
  const [granted, setGranted] = useState<boolean | null>(null);
  // The user pressed Allow and the OS still says no — the prompt was denied
  // (now or in the past); only System Settings can flip it from here.
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    let alive = true;
    void notificationPermissionGranted().then((g) => {
      if (alive) setGranted(g);
    });
    return () => {
      alive = false;
    };
  }, []);

  const usesSystem = prefs.enabled && prefs.mode !== "app";

  return (
    <>
      <span className="form__label">Notifications</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${prefs.enabled === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ notifications: { ...prefs, enabled: on } })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Agent crashes, failed starts and available updates
      </span>

      <span className="form__label">Delivery</span>
      <div className="form__types">
        {NOTIFICATION_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`form__type${mode === prefs.mode ? " form__type--active" : ""}`}
            disabled={!prefs.enabled}
            onClick={() => updateSettings({ notifications: { ...prefs, mode } })}
          >
            {MODE_OPTIONS[mode].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        {prefs.enabled ? MODE_OPTIONS[prefs.mode].hint : "Notifications are off."}
      </span>

      {usesSystem && granted === false && (
        <>
          <span className="settings__hint settings__hint--warn">
            {refused
              ? "The OS is blocking KeepDeck's notifications — allow them in System Settings → Notifications"
              : "KeepDeck doesn't have the OS's permission to show banners yet"}
            {prefs.mode === "system"
              ? "; until then nothing will be shown."
              : "; until then only the bell shows them."}
          </span>
          {!refused && (
            <button
              type="button"
              className="form__cancel"
              onClick={() =>
                void ensureNotificationPermission().then((g) => {
                  setGranted(g);
                  setRefused(!g);
                })
              }
            >
              Allow notifications
            </button>
          )}
        </>
      )}
    </>
  );
}
