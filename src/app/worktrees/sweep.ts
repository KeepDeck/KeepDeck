/**
 * Retiring what no live workspace claims any more.
 *
 * Runs on every deck transition and once the deck has hydrated at boot, which
 * is the pass that clears whatever a crash or an update left behind. Its own
 * module because its reason to change — how a burst is coalesced, when a pass
 * counts as done — has nothing to do with what either planting writes.
 */
import { pruneSkills } from "../../ipc/skills";
import { mcpPrune } from "../../ipc/mcpArming";
import type { LiveWorkspace, WorktreeDeckView, WorktreeHousekeeping } from "./index";
import type { InOrder } from "./queue";
import { unclaimed } from "./roots";

export function createSweep(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  disarm: (roots: string[]) => Promise<boolean>,
): WorktreeHousekeeping {
  /** The deck as the last sweep acted on it, and what the next one diffs against
   * to find the roots that left. `null` = no pass has completed, which is NOT the
   * same as "an empty deck": that first pass is the one that clears what a crash
   * left behind, so it must run even against nothing. Only a pass whose IPCs
   * actually got through records itself here — otherwise a transient failure
   * would be remembered as done and never retried. */
  let swept: LiveWorkspace[] | null = null;

  /** What the live set looks like, for "has anything I act on changed?".
   * Deliberately here and nowhere else: a second projection of the same
   * question, in a React hook, is how the trigger and the answer came to
   * disagree. */
  function fingerprint(live: LiveWorkspace[]): string {
    return JSON.stringify(
      live.map((ws) => [ws.id, [...ws.roots].sort()]).sort(),
    );
  }

  return {
    sweep(deckHydrated) {
      if (!deckHydrated) return Promise.resolve();
      return inOrder(async () => {
        // Compared HERE, not at the call, and that is the whole coalescing
        // mechanism: a burst of transitions queues a burst of passes, and every
        // pass after the first finds the live set already accounted for and costs
        // no IPC. Reading it at the call instead would compare against a `swept`
        // a queued pass was about to overwrite — which is what a second
        // "sweep again" flag then had to paper over.
        const live = deck.live();
        if (swept && fingerprint(swept) === fingerprint(live)) return;
        const departed = unclaimed(swept?.flatMap((ws) => ws.roots) ?? [], live);
        const disarmed = await disarm(departed);
        // Re-read for the PRUNE: the list that decides what to DELETE must not be
        // one IPC round trip old, or a workspace created while the disarm was in
        // flight is pruned as dead and its panes spawn pointing at deleted dirs.
        const liveIds = deck.live().map((ws) => ws.id).sort();
        const sweeps = await Promise.all([pruneSkills(liveIds), mcpPrune(liveIds)]);
        const pruned = sweeps.every(Boolean);
        // Only a pass that got through counts as done. Recording a failed one
        // would retire the very state it failed to clean until the deck happens
        // to change again — and at boot that state is a crash's leftovers.
        if (disarmed && pruned) swept = live;
      });
    },
  };
}
