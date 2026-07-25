import { findPane, paneSuspendBlock, type PaneSuspendBlock } from "../domain/deck";
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
 * the revive sweep, so the directory probe, the resume-plan build and the wake
 * itself are the exact code that restores panes after a restart — one
 * implementation, one set of edge cases. The marker records that a HUMAN
 * asked, which is what stops a rejected session id from quietly becoming a
 * different conversation.
 */
/** What a suspend request did. Not a boolean: three surfaces have to explain a
 * refusal, and each one guessing produced a different sentence — one of them
 * false. The reason travels with the answer so they can share the words. */
export type SuspendOutcome =
  | "suspended"
  | PaneSuspendBlock
  /** A suspend for this pane is already reaping its process. */
  | "in-flight"
  /** The pane (or its workspace) is no longer in the deck. */
  | "gone";

/** One sentence per refusal, so the hotkey, the command and any later surface
 * say the same thing about the same state. */
export function suspendRefusalText(
  outcome: Exclude<SuspendOutcome, "suspended">,
  label: string,
): string {
  switch (outcome) {
    case "idle":
      return `${label} is already stopped.`;
    case "provisioning":
      return `${label} is still creating its worktree.`;
    case "remote":
      return `${label} runs on a remote server — its session lives there, so stopping the local client would not park it.`;
    case "in-flight":
      return `${label} is already being suspended.`;
    case "gone":
      return `${label} is no longer open.`;
  }
}

export interface SuspendApi {
  /** Stop the pane's agent, keeping the pane. Resolves once the process is
   * reaped, so a caller can sequence work (a worktree op) after it — and
   * reports what happened: a caller that announces success regardless would
   * be lying to whoever asked. */
  suspend(wsId: string, paneId: string): Promise<SuspendOutcome>;
  /** Wake a suspended (or parked) pane — the card's resume gesture. */
  resume(wsId: string, paneId: string): void;
}

export function useSuspend(deck: Deck): SuspendApi {
  // No spawn context: suspending builds no plan. The shared refs are here for
  // the race protocol — the flow spans an await, so render-time state goes
  // stale — and the in-flight guard against a double gesture.
  const { deckRef, inFlight } = useLiveRefs(deck, null);

  const suspend = async (
    wsId: string,
    paneId: string,
  ): Promise<SuspendOutcome> => {
    if (inFlight.current.has(paneId)) return "in-flight";
    const pane = findPane(deckRef.current.workspaces, wsId, paneId);
    if (!pane) return "gone";
    const blocked = paneSuspendBlock(pane);
    if (blocked) return blocked;
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
      return "suspended";
    } finally {
      inFlight.current.delete(paneId);
    }
  };

  const resume = (wsId: string, paneId: string) => {
    deckRef.current.wakePane(wsId, paneId);
  };

  return { suspend, resume };
}
