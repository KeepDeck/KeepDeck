import { useEffect, useState } from "react";
import {
  checkForUpdatesNow,
  dismissUpdate,
  downloadUpdate,
  restartToUpdate,
} from "../../app/updateManager";
import { useUpdate } from "../../app/useUpdate";
import { fetchAppInfo } from "../../ipc/app";
import type { UpdateState } from "../../app/updateManager";

/** The status line for each update phase — one honest sentence, no spinners. */
function describeState(state: UpdateState): string {
  switch (state.phase) {
    case "disabled":
      return "Updates are available in release builds only.";
    case "checking":
      return "Checking for updates…";
    case "available":
      if (state.error) return `Download failed: ${state.error} — try again.`;
      return `Version ${state.version ?? "?"} is available — nothing has been downloaded yet.`;
    case "downloading": {
      const progress =
        state.total !== null && state.total > 0
          ? ` ${Math.round((state.received / state.total) * 100)}%`
          : "";
      return `Downloading ${state.version ?? "update"}…${progress}`;
    }
    case "ready":
      if (state.error) return `Install failed: ${state.error} — try again.`;
      return `Version ${state.version ?? "?"} is downloaded — nothing changes until you restart.`;
    case "installing":
      return "Installing the update and restarting…";
    case "idle":
      if (state.error) return `Last check failed: ${state.error}`;
      return state.checkedAt
        ? `Up to date (checked ${new Date(state.checkedAt).toLocaleTimeString()}).`
        : "Not checked yet.";
  }
}

/** The action buttons for each phase. Every transition is an explicit click:
 * check finds, Download fetches, Restart installs — and Dismiss backs out. */
function actions(state: UpdateState) {
  switch (state.phase) {
    case "available":
    case "downloading":
      return [
        {
          key: "download",
          label:
            state.phase === "downloading" ? "Downloading…" : "Download update",
          active: true,
          disabled: state.phase === "downloading",
          onClick: () => void downloadUpdate(),
        },
        {
          key: "dismiss",
          label: "Dismiss",
          active: false,
          disabled: state.phase === "downloading",
          onClick: () => dismissUpdate(),
        },
      ];
    case "ready":
    case "installing":
      return [
        {
          key: "restart",
          label:
            state.phase === "installing" ? "Restarting…" : "Restart to update",
          active: true,
          disabled: state.phase === "installing",
          onClick: () => void restartToUpdate(),
        },
        {
          key: "dismiss",
          label: "Dismiss",
          active: false,
          disabled: state.phase === "installing",
          onClick: () => dismissUpdate(),
        },
      ];
    default:
      return [
        {
          key: "check",
          label: "Check for updates",
          active: false,
          disabled: state.phase !== "idle",
          onClick: () => checkForUpdatesNow(),
        },
      ];
  }
}

/**
 * Updates preferences: the installed version, the live update status, and the
 * consent-driven actions — check, download, restart, dismiss. All state lives
 * in `updateManager`; this section is a thin, always-current view.
 */
export function UpdatesSection() {
  const update = useUpdate();
  const [version, setVersion] = useState<string | null>(null);

  // Per mount, like GeneralSection fetches the agent catalog: the version
  // cannot change without a restart, but the fetch is cheap and mount-scoped.
  useEffect(() => {
    let mounted = true;
    fetchAppInfo()
      .then((info) => {
        if (mounted) setVersion(info.version);
      })
      .catch(() => {
        /* the row simply stays empty outside the tauri shell */
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <>
      <span className="form__label">Version</span>
      <span className="settings__value">
        {version ? `KeepDeck ${version}` : "—"}
      </span>

      <span className="form__label">Updates</span>
      <div className="form__types">
        {actions(update).map((a) => (
          <button
            key={a.key}
            type="button"
            className={`form__type${a.active ? " form__type--active" : ""}`}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </div>
      <span className="settings__hint">{describeState(update)}</span>
    </>
  );
}
