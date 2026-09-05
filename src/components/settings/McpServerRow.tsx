import { useEffect, useState } from "react";
import type { McpStatus } from "../../app/mcp";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { shellLine } from "../../domain/mcp";
import { writeText } from "../../ipc/clipboard";

/**
 * The MCP server's row in General ([F6]): the copy-pasteable connect command,
 * or the reason there is none to show.
 *
 * There is no switch. The socket comes up with the page and stays up, so the
 * row states a FACT about the running transport, never a wish: it keys on
 * the CONFIRMED status, and a refused enable (another instance already holds
 * the socket, no home directory) renders its error where the command would
 * be. The command arrives WITH that status — the MCP owner looks it up once
 * per settled enable instead of this row re-fetching on every mount — and
 * rendering it as a shell line is the only part that is this component's.
 */
export function McpServerRow() {
  const status = useMcpStatus();
  // Keyed on the confirmed socket as well as the line: a line can only ever
  // be minted for a confirmed socket, and the row must not outlive that.
  const connect =
    status.socket !== null && status.connect ? shellLine(status.connect) : null;
  // Reset whenever the command changes, so the confirmation can never stand
  // over a line the user has not actually copied.
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [connect]);
  const line = transportLine(status, connect);

  return (
    <>
      <span className="form__label">MCP server</span>
      {connect !== null && (
        <>
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
        </>
      )}
      {line !== null && (
        <span className="settings__hint kd-selectable">{line}</span>
      )}
      <span className="settings__hint">
        Exposes the deck’s commands (list workspaces, spawn agents, send
        text…) to MCP clients over a local socket, so agents can drive
        KeepDeck. Agent panes started here are given it at spawn; the command
        is for a client KeepDeck does not start itself — a desktop app, an
        editor, an agent you run outside the deck.
      </span>

      {status.refused.length > 0 && (
        // The one case where a pane silently lacks what every other pane got,
        // so the folder AND the reason are on screen: the fix is the user's to
        // make, and it differs — move your own config aside, or the folder is
        // gone, or it could not be written. A single asserted reason sent
        // people looking for a file that was not there.
        <span className="settings__hint kd-selectable">
          KeepDeck’s MCP server was not added for Kimi panes in these folders:
          {status.refused.map((refusal) => (
            <span key={refusal.root} className="settings__refusal">
              {refusal.root} — {refusal.reason}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

/**
 * What to say about the transport beside — or instead of — the command.
 *
 * A problem is said whatever else is on screen: it is the one line that
 * explains why the command is missing, or why the one shown may not work.
 * Without one, the row is never silent while there is no command — the
 * transient states (the enable not yet settled, the lookup still out) each
 * get a sentence, because "no row" would read as "no server".
 */
function transportLine(status: McpStatus, connect: string | null): string | null {
  if (status.error !== null) {
    return `The MCP transport reported a problem: ${status.error}`;
  }
  if (connect !== null) return null;
  if (status.socket === null) return "The server is coming up.";
  if (status.connectError !== null) {
    return `The server is up, but the connect command could not be determined: ${status.connectError}`;
  }
  return "The server is up — looking up its connect command.";
}
