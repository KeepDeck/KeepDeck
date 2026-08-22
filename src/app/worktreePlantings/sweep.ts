/** The feature cleanup pass, composed beside the two planting adapters. */
import { pruneSkills } from "../../ipc/skills";
import { mcpPrune } from "../../ipc/mcpArming";
import type {
  LiveWorkspace,
  WorktreeDeckView,
  WorktreeHousekeeping,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";
import { unclaimed } from "../worktrees/roots";

export function createSweep(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  disarm: (roots: string[]) => Promise<boolean>,
): WorktreeHousekeeping {
  let swept: LiveWorkspace[] | null = null;

  function fingerprint(live: LiveWorkspace[]): string {
    return JSON.stringify(
      live.map((ws) => [ws.id, [...ws.roots].sort()]).sort(),
    );
  }

  return {
    sweep(deckHydrated) {
      if (!deckHydrated) return Promise.resolve();
      return inOrder(async () => {
        const live = deck.live();
        if (swept && fingerprint(swept) === fingerprint(live)) return;
        const departed = unclaimed(swept?.flatMap((ws) => ws.roots) ?? [], live);
        const disarmed = await disarm(departed);
        const liveIds = deck.live().map((ws) => ws.id).sort();
        const sweeps = await Promise.all([pruneSkills(liveIds), mcpPrune(liveIds)]);
        const pruned = sweeps.every(Boolean);
        if (disarmed && pruned) swept = live;
      });
    },
  };
}
