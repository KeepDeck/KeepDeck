import { useEffect, useState } from "react";
import { updateSettings } from "../../app/settingsManager";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { useSettings } from "../../app/useSettings";
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
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;
  const mcpServer = settings?.mcpServer ?? DEFAULT_SETTINGS.mcpServer;
  const agentTeams = settings?.agentTeams ?? DEFAULT_SETTINGS.agentTeams;
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
          To build one: double-click the “team” chip in an agent’s header and
          type a role and a team, like <code>lead@api</code>. Do the same on
          the others with <code>impl-1@api</code>, <code>impl-2@api</code>.
          The role is the address teammates use; clearing the field takes an
          agent off the team.
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
    </>
  );
}
