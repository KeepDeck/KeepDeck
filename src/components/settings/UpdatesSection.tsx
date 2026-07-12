import { useEffect, useState } from "react";
import { checkForUpdatesNow, restartToUpdate } from "../../app/updateManager";
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
    case "downloading": {
      const progress =
        state.total !== null && state.total > 0
          ? ` ${Math.round((state.received / state.total) * 100)}%`
          : "";
      return `Downloading ${state.version ?? "update"}…${progress}`;
    }
    case "ready":
      return `Version ${state.version ?? "?"} is downloaded — restart to apply.`;
    case "installing":
      return "Installing the update and restarting…";
    case "idle":
      if (state.error) return `Last check failed: ${state.error}`;
      return state.checkedAt
        ? `Up to date (checked ${new Date(state.checkedAt).toLocaleTimeString()}).`
        : "Not checked yet.";
  }
}

/**
 * Updates preferences: the installed version, the live update status, and the
 * two actions — check now, and restart into a downloaded update. All state
 * lives in `updateManager`; this section is a thin, always-current view.
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
      <span className="settings__hint">
        {version ? `KeepDeck ${version}` : "—"}
      </span>

      <span className="form__label">Updates</span>
      <div className="form__types">
        {update.phase === "ready" || update.phase === "installing" ? (
          <button
            type="button"
            className="form__type form__type--active"
            disabled={update.phase === "installing"}
            onClick={() => void restartToUpdate()}
          >
            {update.phase === "installing" ? "Restarting…" : "Restart to update"}
          </button>
        ) : (
          <button
            type="button"
            className="form__type"
            disabled={update.phase !== "idle"}
            onClick={() => checkForUpdatesNow()}
          >
            Check for updates
          </button>
        )}
      </div>
      <span className="settings__hint">{describeState(update)}</span>
    </>
  );
}
