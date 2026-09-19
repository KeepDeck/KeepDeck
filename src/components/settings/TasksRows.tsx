import { updateSettings } from "../../app/settingsManager";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";

/**
 * Tasks in General ([F6]): the switch for the team-owned board of work
 * orders, in the row shape its neighbours use (label + On/Off + hint).
 *
 * Live in both directions: On claims the board store and registers the
 * task_* commands, Off releases the store and unregisters them.
 *
 * Agents reach the board through the deck's MCP socket, like artifacts.
 * The socket has no switch of its own, so this row says so only while it
 * is actually DOWN, keyed on the same confirmed status the registration
 * gate reads. The dialog keeps working either way — it is the agents'
 * half that goes with the socket.
 */
export function TasksRows() {
  const settings = useSettings();
  const tasks = settings?.tasks ?? DEFAULT_SETTINGS.tasks;
  const served = useMcpStatus().socket !== null;

  return (
    <>
      <span className="form__label">Tasks</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${tasks === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ tasks: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        A board of work orders per team: the lead puts tasks on it, agents
        read their own and move them along, and you see who is on what and
        what waits in review. Agents learn about a task from a teammate’s
        mail, never from the board itself. On claims the board store; Off
        releases it.
      </span>

      {tasks && !served && (
        <span className="settings__hint">
          The deck’s MCP socket is down (see below): agents read and write
          the board by calling the deck, so they cannot until it is back.
          The Tasks dialog keeps working.
        </span>
      )}
    </>
  );
}
