/**
 * The card a pane wears with no PTY behind it.
 *
 * Three states in one place because they are the same question — why is
 * nothing running, and what gets it back — answered from what the pane
 * knows. A rising pane is normally transient (the revive sweep wakes
 * active-workspace panes) and persists only when its directory is gone; the
 * other reasons wait for the user.
 */
import type { PaneIdle } from "../../../domain/deck";
import { formatAge } from "../../../domain/usage";

export function StoppedBody({
  idle,
  stopped,
  blockedDir,
  wakeError,
  resumeSessionId,
  now,
  onResume,
  onStartFresh,
}: {
  idle: PaneIdle;
  /** Whether the process is really gone, as opposed to on its way back. */
  stopped: boolean;
  /** The directory this pane cannot come back to, when that is why. */
  blockedDir?: string | null;
  /** A resume that was asked for and refused. */
  wakeError?: string | null;
  /** The session a resume would rejoin, or null for a fresh one. */
  resumeSessionId?: string | null;
  now: number;
  onResume?: () => void;
  onStartFresh?: () => void;
}) {
  return (
    <div className="pane__card" role="status">
      {blockedDir ? (
        <>
          <span className="pane__exit-title">Folder is gone</span>
          <span className="pane__exit-sub pane__card-path" title={blockedDir}>
            {blockedDir}
          </span>
          {/* Two ways out, and the order matters: looking again costs nothing
              and keeps the session, while starting fresh throws the binding
              away with the folder. */}
          {onResume && (
            <button type="button" className="pane__card-action" onClick={onResume}>
              Look again
            </button>
          )}
          {onStartFresh && (
            <button
              type="button"
              className="pane__card-action"
              onClick={onStartFresh}
            >
              Start fresh in the workspace folder
            </button>
          )}
        </>
      ) : !stopped ? (
        <span className="pane__exit-title">Waking up…</span>
      ) : (
        <>
          <span className="pane__exit-title">
            {/* "Stopped" matches the launch setting that produces this state;
                a pane the user suspended says so, and dates it. */}
            {idle.reason === "suspended" ? "Suspended" : "Stopped"}
          </span>
          {idle.reason === "suspended" && (
            <span className="pane__exit-sub">
              {formatAge(Date.parse(idle.at), now)}
            </span>
          )}
          {/* A resume that was asked for and refused: say why here, where the
              button that will be pressed again lives. No role of its own —
              the card around it is already a live region, and a nested one
              has undefined behaviour. */}
          {wakeError && (
            <span className="pane__exit-sub pane__wake-error">
              Couldn't resume — {wakeError}
            </span>
          )}
          {/* Say what the button does AND which session it does it to: the
              pane's own binding, so a stopped agent can be matched against
              the agent's session store (or the Sessions browser) without
              waking it first. Ellipsized in a narrow tile; the title carries
              the full id. */}
          {resumeSessionId ? (
            <span
              className="pane__exit-sub pane__card-path pane__idle-session kd-selectable"
              title={resumeSessionId}
            >
              Resume session:{" "}
              <span className="pane__idle-session-id">{resumeSessionId}</span>
            </span>
          ) : (
            <span className="pane__exit-sub">Starts a fresh session</span>
          )}
          {onResume && (
            <button type="button" className="pane__card-action" onClick={onResume}>
              {/* One verb for both reasons: the gesture is identical (hand the
                  pane back to the revive sweep) and, bound or not, the line
                  above already says what it will do. */}
              Resume
            </button>
          )}
        </>
      )}
    </div>
  );
}
