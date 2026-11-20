import { useEffect, useRef, useState } from "react";
import type { AgentRestartMode } from "../../domain/agents";
import type { IntentOutcome } from "../../domain/lifecycle";

/**
 * The restart card's own state machine.
 *
 * Three pieces of state, a ref, and two rules that are easy to get wrong and
 * invisible when they are — which is why it is a hook rather than twenty
 * lines inside a 600-line render, where nothing could reach it without
 * mounting the whole pane.
 *
 * Rule one: a restart the machine took on remounts the pane through its
 * epoch, so the spinner is cleared by the remount and NOT by the promise. A
 * restart it refused — the pane was stopped, closing or still being created
 * — resolves without a remount, so treating "resolved" as "restarted" leaves
 * the card promising a restart that is not coming. Only an accepted one
 * keeps the spinner; one the machine never answered may be tried again.
 *
 * Rule two: a pane that stops keeps its component MOUNTED — suspending and
 * resuming bump no epoch, unlike a restart — so this state would otherwise
 * outlive the process it describes. An exited pane parked and then resumed
 * would paint "Agent exited" over a live terminal, with a Restart button
 * that kills the session the user just brought back.
 */
export interface RestartState {
  /** A restart is in flight; both choices stay inert until it settles. */
  restarting: boolean;
  /** The last attempt was refused, so the user may try again. */
  restartFailed: boolean;
  /** Ask for one. Ignored while another is in flight, or with no handler. */
  restart(mode: AgentRestartMode): void;
}

export function useRestart(
  onRestart: ((mode: AgentRestartMode) => Promise<IntentOutcome>) | undefined,
  /** Whether the pane is idle — any truthy value resets the machine, because
   * a pane that stopped has no restart in flight to describe. */
  idle: unknown,
): RestartState {
  const inFlight = useRef(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);

  useEffect(() => {
    if (!idle) return;
    inFlight.current = false;
    setRestarting(false);
    setRestartFailed(false);
  }, [idle]);

  const restart = (mode: AgentRestartMode) => {
    if (!onRestart || inFlight.current) return;
    inFlight.current = true;
    setRestarting(true);
    setRestartFailed(false);

    const recover = () => {
      inFlight.current = false;
      setRestarting(false);
      setRestartFailed(true);
    };
    const settle = (outcome: IntentOutcome) => {
      // See rule one: only a remount clears a real restart.
      if (outcome.kind === "accepted") return;
      if (outcome.kind === "unanswered") return recover();
      inFlight.current = false;
      setRestarting(false);
    };
    try {
      void Promise.resolve(onRestart(mode)).then(settle, recover);
    } catch {
      recover();
    }
  };

  return { restarting, restartFailed, restart };
}
