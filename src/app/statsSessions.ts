import { sessionClaimant, type Pane, type SessionClaimKey } from "../domain/deck";
import type { StatsSessions } from "./useStatsView";

/**
 * Statistics' door to the pane a session runs in. Whether a pane holds the
 * session is the claimant every resume surface agrees through; bringing it
 * in front closes the dialog FIRST — it would cover the pane — and then
 * activates the pane the way every other door does. A session no pane
 * holds any longer (it closed while the row was on screen) opens nothing.
 */
export function createStatsSessions(deps: {
  workspaces(): readonly { id: string; panes: Pane[] }[];
  blocked(paneId: string): boolean;
  closeStats(): void;
  activatePane(wsId: string, paneId: string): void;
}): StatsSessions {
  const claimantOf = (session: SessionClaimKey) => sessionClaimant(deps.workspaces(), session, deps.blocked);
  return {
    held: (session) => claimantOf(session) !== null,
    reveal: (session) => {
      const claimant = claimantOf(session);
      if (claimant === null) return;
      deps.closeStats();
      deps.activatePane(claimant.wsId, claimant.pane.id);
    },
  };
}
