/**
 * Keeping an agent's own standing true for it, rather than saying it once.
 *
 * A briefing given at assignment is only true for as long as the agent
 * remembers it, and there are two ordinary ways it stops: the conversation
 * starts over (a fresh session, a `/clear`, a pane restored without its
 * history), and the context is compacted out from under a long-running one.
 * Either way the agent is still ON the team and has no idea — which is
 * worse than never being told, because the deck now believes it knows.
 *
 * So the briefing is a standing fact the deck RE-STATES whenever the memory
 * of it may have gone. Not on a timer and not per turn: only on the two
 * moments that actually erase it, both of which the deck already observes.
 *
 * A pane on no team is silent, so this costs nothing for anyone not using
 * the feature.
 */
import { teamBriefing } from "../../domain/mail";
import { log } from "../../ipc/log";

/** Where a pane stands, as the briefing needs it. */
export interface TeamStanding {
  team: string;
  role: string;
  /** Every role on the team, this one included — the briefing drops it. */
  everyRole: string[];
}

export interface TeamPresenceDeps {
  /** This pane's standing right now, or null when it is on no team. Read
   * per call: membership changes under us. */
  standingOf(paneId: string): TeamStanding | null;
  /** Say it, as the deck. Absent manager (feature off) is the caller's to
   * swallow. */
  announce(paneId: string, body: string): void;
  /** A pane whose agent started a conversation remembering nothing. */
  onSessionBegan(listener: (paneId: string) => void): () => void;
  /** A pane whose context was rebuilt under it. */
  onContextRebuilt(listener: (paneId: string) => void): () => void;
  /** The role catalog changed — the charters and summaries every live
   * briefing was built from may no longer be what the deck believes. */
  onCatalogChanged(listener: () => void): () => void;
  /** Everyone currently on any team — the panes whose briefing that change
   * may have rewritten. Read per call: membership moves. */
  teamedPanes(): string[];
  /** The deck's roster moved — a pane appeared, joined or left. What a
   * catalog sweep that found nobody retries on. */
  onRosterChanged(listener: () => void): () => void;
}

export function createTeamPresence(deps: TeamPresenceDeps): { dispose(): void } {
  const restate = (why: string) => (paneId: string) => {
    const standing = deps.standingOf(paneId);
    // Logged either way. "Nothing was re-stated" is the answer half the
    // time — the pane is on no team — and without the line it is
    // indistinguishable from a signal that never arrived.
    log.info(
      "web:mail",
      `${paneId} ${why}: ${standing ? `re-stating ${standing.role} on ${standing.team}` : "on no team"}`,
    );
    if (!standing) return;
    deps.announce(
      paneId,
      teamBriefing(standing.team, standing.role, standing.everyRole),
    );
  };

  // A catalog change that found NOBODY teamed is OWED, not done. At boot,
  // a cross-session file edit fires the change before the restored deck
  // has hydrated — consumed then, every restored team would keep briefing
  // from texts the disk no longer holds, with no per-pane trigger left to
  // save them. The debt is paid on the next roster movement that brings a
  // teamed pane.
  let owedSweep = false;
  const sweep = (why: string) => {
    const panes = deps.teamedPanes();
    if (panes.length === 0) {
      owedSweep = true;
      return;
    }
    owedSweep = false;
    for (const paneId of panes) restate(why)(paneId);
  };

  const unsubscribes = [
    deps.onSessionBegan(restate("began a fresh session")),
    deps.onContextRebuilt(restate("had its context rebuilt")),
    // One event, many panes: unlike the two signals above this one names
    // nobody, so the walk over the teamed panes lives here. `restate`
    // re-reads each standing, and standing context supersedes itself in
    // the queue — a pane that collects nothing meanwhile holds ONE
    // briefing, not a pile.
    deps.onCatalogChanged(() => sweep("the role catalog changed")),
    deps.onRosterChanged(() => {
      if (owedSweep) sweep("the role catalog changed before the deck was up");
    }),
  ];

  return {
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
