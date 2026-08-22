import { useEffect, useState } from "react";
import { updateSettings } from "../../app/settingsManager";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { useSettings } from "../../app/useSettings";
import { leadRole, peerRole, teamRoles } from "../../domain/mail";
import { shellLine } from "../../domain/mcp";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { writeText } from "../../ipc/clipboard";

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
 * their endpoint until closed. MCP server is a LIVE switch in both
 * directions: On brings the deck's command socket up, Off tears it down and
 * disconnects its clients. Agent mail is live in both directions too, and
 * gates BOTH halves of its feature — off, nothing can be sent and nothing
 * is delivered.
 *
 * Agent mail depends on the MCP server and says so only when the pairing is
 * actually wrong. Delivery reaches a pane through its terminal either way,
 * but sending is an MCP call, so mail-on/socket-off is the one combination
 * that leaves a pane able to receive and unable to answer.
 *
 * The connect row keys on the CONFIRMED transport status, not the setting:
 * the setting is a wish, and the two differ exactly when the user most needs
 * to know (another instance already holds the socket, enable failed) — so a
 * failed transition renders its error where the command would be. The command
 * itself arrives WITH that status: it is a fact about the running transport,
 * true whether or not this dialog is open, so the MCP owner looks it up once
 * per settled transition instead of this row re-fetching on every mount.
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
  const mcpServer = settings?.mcpServer ?? DEFAULT_SETTINGS.mcpServer;
  const agentTeams = settings?.agentTeams ?? DEFAULT_SETTINGS.agentTeams;
  const artifacts = settings?.artifacts ?? DEFAULT_SETTINGS.artifacts;
  const artifactAutoOpen =
    settings?.artifactAutoOpen ?? DEFAULT_SETTINGS.artifactAutoOpen;
  const mcpStatus = useMcpStatus();
  const served = mcpStatus.socket !== null;
  // The invocation comes from the transport's own status — a fact about the
  // running socket, not something this row goes and fetches. Rendering it as
  // a shell line is the only part that is this component's.
  const connect = mcpStatus.connect ? shellLine(mcpStatus.connect) : null;
  const connectError = mcpStatus.connectError;
  // Reset whenever the command changes, so the confirmation can never stand
  // over a line the user has not actually copied.
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [connect]);

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

      <span className="form__label">MCP server</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${mcpServer === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ mcpServer: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Exposes the deck’s commands (list workspaces, spawn agents, send
        text…) to MCP clients over a local socket, so agents can drive
        KeepDeck. On brings the socket up, Off tears it down and disconnects
        its clients — no restart needed. Off by default — the feature is
        experimental.
      </span>

      {served && (
        // Said only while the socket is CONFIRMED up: a pane is given the
        // server at spawn, so this promise is only true when there is one.
        <span className="settings__hint">
          New agent panes connect to it automatically — nothing to add on the
          agent’s side. Panes that are already running pick it up when they
          restart.
        </span>
      )}

      {mcpStatus.refused.length > 0 && (
        // The one case where a pane silently lacks what every other pane got,
        // so the folder AND the reason are on screen: the fix is the user's to
        // make, and it differs — move your own config aside, or the folder is
        // gone, or it could not be written. A single asserted reason sent
        // people looking for a file that was not there.
        <span className="settings__hint kd-selectable">
          KeepDeck’s MCP server was not added for Kimi panes in these folders:
          {mcpStatus.refused.map((refusal) => (
            <span key={refusal.root} className="settings__refusal">
              {refusal.root} — {refusal.reason}
            </span>
          ))}
        </span>
      )}

      {mcpStatus.error !== null && (
        // Unconditional: a failed DISABLE happens exactly when the setting
        // is already Off — gating on the setting would hide the one report
        // that says the socket may still be serving.
        <span className="settings__hint kd-selectable">
          The MCP transport reported a problem: {mcpStatus.error}
        </span>
      )}

      {served && connect !== null && (
        <>
          <span className="form__label">MCP connect</span>
          {/* Read-only by nature, so it must not look like a field — and
              the copy sits in an ordinary control row underneath, where
              every other button in settings lives. */}
          <div className="settings__command kd-selectable">{connect}</div>
          <div className="form__types">
            <button
              type="button"
              className="form__type"
              onClick={() => {
                void writeText(connect)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <span className="settings__hint">
            For MCP clients KeepDeck does not start itself — a desktop app, an
            editor, an agent you run outside the deck. Panes started here are
            connected already.
            {mcpStatus.error !== null &&
              " This was the last confirmed socket; the problem above may mean it is no longer reachable."}
          </span>
        </>
      )}

      {served && connectError !== null && (
        <span className="settings__hint kd-selectable">
          The server is up, but the connect command could not be determined:{" "}
          {connectError}
        </span>
      )}

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

      {agentTeams && !mcpServer && (
        // Stated only in the combination that is actually broken. Delivery
        // rides the pane's terminal and works regardless, but SENDING is an
        // MCP call — so with the socket down a pane can be written to and has
        // no way to answer, which is worse than the feature being off.
        <span className="settings__hint">
          Turn the MCP server on as well: agents send mail by calling the
          deck, so with the socket down they can receive but never reply.
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
        // Keyed on the CONFIRMED socket (the same observable the
        // registration gate reads), not the setting: mcpServer-ON with a
        // failed socket showed neither tools nor this hint — the hint and
        // the gate must agree on what "the transport is down" means.
        // Same shape as the teams pairing: the pages keep serving with the
        // transport off, but PUBLISHING is an MCP call — a pane could be
        // asked to show something and have no way to do it.
        <span className="settings__hint">
          Turn the MCP server on as well: agents publish artifacts by
          calling the deck, so with the socket down they cannot publish
          (pages already published keep serving).
        </span>
      )}
    </>
  );
}
