import { updateSettings } from "../../app/settingsManager";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";

/**
 * Experimental features ([F6] → Experimental) — opt-in capabilities that ship
 * behind a setting because they aren't done. Each row mirrors the General
 * section's toggle pattern (label + On/Off + hint) so the sizing, spacing and
 * typography match every other section, and each choice persists across
 * restarts like every other setting.
 *
 * The toggles gate differently — the hints say so, this is why: Remote
 * agents gates the CREATION surface (the "+ Agent" dialog) only, so turning
 * it off hides the option going forward while existing remote panes keep
 * their endpoint until closed. Fleet artifacts is live in both directions:
 * On claims the store and starts the display server, Off closes every page
 * and releases it.
 *
 * Artifacts ride the deck's MCP socket — publishing is an MCP call. The
 * socket has no switch of its own (it comes up with the app and is reported
 * in General), so the row says so only while it is actually DOWN, keyed on
 * the CONFIRMED status: the same observable the tool-registration gate
 * reads, so the hint and the gate agree on what "down" means. Already
 * published pages keep serving; it is a pane's ability to publish that goes
 * with the socket.
 */
export function ExperimentalSection() {
  const settings = useSettings();
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;
  const artifacts = settings?.artifacts ?? DEFAULT_SETTINGS.artifacts;
  const artifactAutoOpen =
    settings?.artifactAutoOpen ?? DEFAULT_SETTINGS.artifactAutoOpen;
  const served = useMcpStatus().socket !== null;

  return (
    <>
      <span className="form__label">Remote agents</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${remoteAgents === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ remoteAgents: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Lets an agent that speaks a client/server protocol (Codex, OpenCode)
        run against a remote endpoint from the “+ Agent” dialog’s Where option.
        Off by default — the feature is experimental.
      </span>

      <span className="form__label">Fleet artifacts</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${artifacts === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ artifacts: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Lets agents publish presentation pages (HTML or Markdown) that open
        in your browser, refresh live as the agent iterates, and can be
        read and reviewed by teammates. On claims the artifact store and
        starts the local display server; Off closes every open page and
        releases the store. Off by default — the feature is experimental.
      </span>

      {artifacts && artifactAutoOpen && (
        <span className="settings__hint">
          The first publish of a new artifact opens it in the browser
          automatically; later versions refresh the open page instead of
          opening tabs. (Turn "Auto-open artifacts" off to publish
          silently.)
        </span>
      )}

      {artifacts && (
        <span className="form__label">Auto-open artifacts</span>
      )}
      {artifacts && (
        <div className="form__types">
          {[true, false].map((on) => (
            <button
              key={String(on)}
              type="button"
              className={`form__type${artifactAutoOpen === on ? " form__type--active" : ""}`}
              onClick={() => updateSettings({ artifactAutoOpen: on })}
            >
              {on ? "On" : "Off"}
            </button>
          ))}
        </div>
      )}

      {artifacts && !served && (
        // Stated only in the combination that is actually broken: the pages
        // keep serving with the socket down, but PUBLISHING is an MCP call —
        // a pane could be asked to show something and have no way to do it.
        <span className="settings__hint">
          The deck’s MCP socket is down (see General): agents publish
          artifacts by calling the deck, so they cannot publish until it is
          back (pages already published keep serving).
        </span>
      )}
    </>
  );
}
