import { useEffect, useState } from "react";
import { updateSettings } from "../../app/settingsManager";
import { useMcpStatus } from "../../app/useMcpStatus";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { mcpConnectionCommand, type McpConnection } from "../../ipc/mcp";

/** The {command,args} invocation as one copy-pasteable shell line — quoting
 * only what needs it, so the common spaceless path stays clean. */
function shellLine({ command, args }: McpConnection): string {
  const word = (w: string) =>
    /[\s"'\\]/.test(w) ? `"${w.replace(/[\\"]/g, "\\$&")}"` : w;
  return [command, ...args].map(word).join(" ");
}

/**
 * Experimental features ([F6] → Experimental) — opt-in capabilities that ship
 * behind a setting because they aren't done. Each row mirrors the General
 * section's toggle pattern (label + On/Off + hint) so the sizing, spacing and
 * typography match every other section, and each choice persists across
 * restarts like every other setting.
 *
 * The two toggles gate differently — the hints say so, this is why: Remote
 * agents gates the CREATION surface (the "+ Agent" dialog) only, so turning
 * it off hides the option going forward while existing remote panes keep
 * their endpoint until closed. MCP server is a LIVE switch in both
 * directions: On brings the deck's command socket up, Off tears it down and
 * disconnects its clients.
 *
 * The connect row keys on the CONFIRMED transport status, not the setting:
 * the setting is a wish, and the two differ exactly when the user most needs
 * to know (another instance already holds the socket, enable failed) — so a
 * failed transition renders its error where the command would be.
 */
export function ExperimentalSection() {
  const settings = useSettings();
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;
  const mcpServer = settings?.mcpServer ?? DEFAULT_SETTINGS.mcpServer;
  const mcpStatus = useMcpStatus();
  // The command is fetched, not computed: only the backend knows where this
  // install's binary lives. A fetch failure is a message, never a silently
  // missing row — the server IS serving.
  const [connect, setConnect] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const served = mcpStatus.socket !== null;
  useEffect(() => {
    if (!served) {
      setConnect(null);
      setConnectError(null);
      return;
    }
    let stale = false;
    void mcpConnectionCommand()
      .then((connection) => {
        if (!stale) setConnect(shellLine(connection));
      })
      .catch((e: unknown) => {
        if (!stale)
          setConnectError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stale = true;
    };
  }, [served]);

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

      {mcpServer && mcpStatus.error !== null && (
        <span className="settings__hint">
          The MCP server could not start: {mcpStatus.error}
        </span>
      )}

      {served && connect !== null && (
        <>
          <span className="form__label">MCP connect</span>
          <input
            className="form__input"
            readOnly
            value={connect}
            onFocus={(e) => e.currentTarget.select()}
          />
          <span className="settings__hint">
            The stdio command an MCP client spawns to reach the deck — add it
            to any client as a stdio server.
          </span>
        </>
      )}

      {served && connectError !== null && (
        <span className="settings__hint">
          The server is up, but the connect command could not be determined:{" "}
          {connectError}
        </span>
      )}
    </>
  );
}
