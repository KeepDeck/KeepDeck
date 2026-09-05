import { updateSettings } from "../../app/settingsManager";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { useSettings } from "../../app/useSettings";
import { leadRole, peerRole, teamRoles } from "../../domain/mail";
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
 * their endpoint until closed. Agent teams is live in both directions and
 * gates BOTH halves of its feature — off, nothing can be sent and nothing
 * is delivered. Fleet artifacts is live too: On claims the store and starts
 * the display server, Off closes every page and releases it.
 *
 * Teams and artifacts ride the deck's MCP socket — sending mail and
 * publishing are MCP calls. The socket has no switch of its own (it comes up
 * with the app and is reported in General), so each says so only while it
 * is actually DOWN, keyed on the CONFIRMED status: the same observable the
 * tool-registration gate reads, so the hint and the gate agree on what
 * "down" means. Delivery and already published pages work regardless; it is
 * a pane's ability to answer, or to publish, that goes with the socket.
 */
export function ExperimentalSection() {
  const settings = useSettings();
  // The roles on offer, read from the catalog rather than listed here — and
  // read PER RENDER, not at import: as a module constant this was frozen
  // before the user's catalog had even loaded. Per render, not per catalog
  // change — the hint refreshes when the dialog does, which is when it is
  // read; a live subscription would be ceremony for a sentence.
  const roleSummary = teamRoles()
    .map((role) => role.label)
    .join(", ");
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;
  const agentTeams = settings?.agentTeams ?? DEFAULT_SETTINGS.agentTeams;
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

      <span className="form__label">Agent teams</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${agentTeams === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ agentTeams: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Groups the agents in a workspace into a team, each under a role, and
        lets them write to each other by that role — a lead can hand out a
        task, and an agent stuck on something can ask a teammate and get an
        answer. A message waits while its pane sits on a permission prompt,
        and is dropped rather than delivered late. Off by default — the
        feature is experimental.
      </span>

      {agentTeams && (
        // Where to actually do it. The gesture is in a pane header and
        // nothing else announces it, so the setting that turns the feature
        // on is the one place guaranteed to be read by someone looking for
        // it.
        <span className="settings__hint">
          To build one: use the team button in the workspace bar. Name the
          team, put agents on it, and give each a role — {roleSummary}. The
          role says what a member is for AND is the address teammates write
          to. A led team needs exactly one {leadRole().label.toLowerCase()},
          the member that hands out the work — or make everyone a{" "}
          {peerRole().label.toLowerCase()} for a flat team, where agents
          work as equals and nobody assigns.
        </span>
      )}

      {agentTeams && !served && (
        // Stated only in the combination that is actually broken. Delivery
        // rides the pane's terminal and works regardless, but SENDING is an
        // MCP call — so with the socket down a pane can be written to and has
        // no way to answer, which is worse than the feature being off.
        <span className="settings__hint">
          The deck’s MCP socket is down (see General): agents send mail by
          calling the deck, so they can receive but never reply until it is
          back.
        </span>
      )}

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
        // Same shape as the teams pairing: the pages keep serving with the
        // socket down, but PUBLISHING is an MCP call — a pane could be asked
        // to show something and have no way to do it.
        <span className="settings__hint">
          The deck’s MCP socket is down (see General): agents publish
          artifacts by calling the deck, so they cannot publish until it is
          back (pages already published keep serving).
        </span>
      )}
    </>
  );
}
