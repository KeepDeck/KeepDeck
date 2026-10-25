import { useEffect, useState } from "react";
import { downloadPercent } from "@keepdeck/plugin-api";
import { isFoundUpdate, useUpdate, useUpdateActions, type UpdateActions, type UpdateState } from "../../app/useUpdate";
import { UpdateChangelog } from "./UpdateChangelog";

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
      const percent = downloadPercent(state);
      const progress = percent === null ? "" : ` ${percent}%`;
      return `Downloading ${state.version ?? "update"}…${progress}`;
    }
    case "ready":
      if (state.error) return `Install failed: ${state.error} — try again.`;
      return `Version ${state.version ?? "?"} is downloaded — nothing changes until you restart.`;
    case "installing":
      if (state.error) return state.error;
      return "Installing the update and restarting…";
    case "discarding":
      return "Discarding the downloaded update…";
    case "idle":
      if (state.error) return `Last check failed: ${state.error}`;
      return state.checkedAt
        ? `Up to date (checked ${new Date(state.checkedAt).toLocaleTimeString()}).`
        : "Not checked yet.";
  }
}

/** The action buttons for each phase. Every transition is an explicit click:
 * check finds, Download fetches, Restart installs — and Dismiss backs out. */
function actions(state: UpdateState, update: UpdateActions) {
  switch (state.phase) {
    case "available":
      return [
        {
          key: "download",
          label: "Download update",
          active: true,
          disabled: false,
          onClick: () => void update.download(),
        },
        {
          key: "dismiss",
          label: "Dismiss",
          active: false,
          disabled: false,
          onClick: () => void update.dismiss(),
        },
      ];
    case "downloading":
      return [
        {
          key: "cancel",
          label: "Cancel",
          active: false,
          disabled: false,
          onClick: () => update.cancel(),
        },
      ];
    case "ready":
    case "installing":
    case "discarding":
      return [
        {
          key: "restart",
          label:
            state.phase === "installing"
              ? "Restarting…"
              : state.phase === "discarding"
                ? "Discarding…"
                : "Restart to update",
          active: true,
          disabled: state.phase === "installing" || state.phase === "discarding",
          onClick: () => void update.restart(),
        },
        {
          key: "dismiss",
          label: "Dismiss",
          active: false,
          disabled: state.phase === "installing" || state.phase === "discarding",
          onClick: () => void update.dismiss(),
        },
      ];
    default:
      return [
        {
          key: "check",
          label: "Check for updates",
          active: false,
          disabled: state.phase !== "idle",
          onClick: () => void update.check(),
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
  const updateActions = useUpdateActions();
  const [version, setVersion] = useState<string | null>(null);

  // One read per process, shared with the bar and the update manager; the
  // version cannot change without a restart, so the shell is asked once.
  useEffect(() => {
    let mounted = true;
    updateActions.appInfo()
      .then((info) => {
        if (mounted) setVersion(info.version);
      })
      .catch(() => {
        /* the row simply stays empty outside the tauri shell */
      });
    return () => {
      mounted = false;
    };
  }, [updateActions]);

  return (
    <>
      <span className="form__label">Version</span>
      <span className="settings__value">
        {version ? `KeepDeck ${version}` : "—"}
      </span>

      <span className="form__label">Updates</span>
      <div className="form__types">
        {actions(update, updateActions).map((a) => (
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

      {isFoundUpdate(update) && <UpdateChangelog entries={update.changelog} />}
    </>
  );
}
