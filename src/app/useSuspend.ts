import { findPane, paneCanSuspend } from "../domain/deck";
import { log } from "../ipc/log";
import { closePane } from "./ptyManager";
import { dropPaneSpawnSpec } from "./spawnSpecs";
import { clearPaneUsage } from "./usageManager";
import type { Deck } from "./useDeck";
import { useLiveRefs } from "./useLiveRefs";

/**
 * Suspending an agent: end its process while the pane keeps everything that
 * makes it resumable — its place in the deck, its name, its worktree and its
 * session binding. The mirror of closing, which takes all of that away.
 *
 * Resuming is deliberately NOT a second wake path: it hands the pane back to
 * the revive sweep as a `restored` one, so the directory probe, the
 * resume-plan build and the wake itself are the exact code that restores panes
 * after a restart — one implementation, one set of edge cases.
 */
export interface SuspendApi {
  /** Stop the pane's agent, keeping the pane. Resolves once the process is
   * reaped, so a caller can sequence work (a worktree op) after it. */
  suspend(wsId: string, paneId: string): Promise<void>;
  /** Wake a suspended (or parked) pane — the card's resume gesture. */
  resume(wsId: string, paneId: string): void;
}

export function useSuspend(deck: Deck): SuspendApi {
  // No spawn context: suspending builds no plan. The shared refs are here for
  // the race protocol — the flow spans an await, so render-time state goes
  // stale — and the in-flight guard against a double gesture.
  const { deckRef, inFlight } = useLiveRefs(deck, null);

  const suspend = async (wsId: string, paneId: string) => {
    if (inFlight.current.has(paneId)) return;
    const pane = findPane(deckRef.current.workspaces, wsId, paneId);
    if (!pane || !paneCanSuspend(pane)) return;
    inFlight.current.add(paneId);
    try {
      log.info("web:suspend", `${paneId}: suspending`);
      // ORDER MATTERS, and it is the reverse of what closing does.
      //
      // Marking the pane idle FIRST takes it out of the spawn-plan sweep and
      // unmounts its terminal. Tearing the process down first would leave a
      // live, plan-less pane for a beat — long enough for the sweep to build
      // it a fresh plan and acquire a NEW process, which the following
      // suspend would then orphan (unmounting a view never kills a session;
      // only `closePane` does).
      deckRef.current.suspendPane(wsId, paneId);
      // Revoke the bridge token before the process can report anything else;
      // a postback landing in the gap above is harmless (it binds the pane's
      // own real session, which is exactly what a later resume wants).
      dropPaneSpawnSpec(paneId);
      clearPaneUsage(paneId);
      await closePane(paneId);
    } finally {
      inFlight.current.delete(paneId);
    }
  };

  const resume = (wsId: string, paneId: string) => {
    deckRef.current.wakePane(wsId, paneId);
  };

  return { suspend, resume };
}
