/** The feature cleanup pass, composed beside the two planting adapters. */
import { pruneSkills } from "../../ipc/skills";
import { pruneMcpLibrary } from "../../ipc/mcpLibrary";
import { cwdArmPrune } from "../../ipc/cwdArm";
import type {
  LiveWorkspace,
  WorktreeDeckView,
  WorktreeHousekeeping,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export function createSweep(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  disarm: (roots: string[]) => Promise<string[] | null>,
  prunePluginDirs: (liveWsIds: readonly string[]) => Promise<boolean>,
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
        // Every root the last sweep saw; the ones still live stay armed —
        // disarm's own guard, the one place that rule lives.
        const disarmed = await disarm([
          ...new Set(swept?.flatMap((ws) => ws.roots) ?? []),
        ]);
        const liveIds = deck.live().map((ws) => ws.id).sort();
        const sweeps = await Promise.all([
          pruneSkills(liveIds),
          pruneMcpLibrary(liveIds),
          cwdArmPrune(liveIds),
          prunePluginDirs(liveIds),
        ]);
        const pruned = sweeps.every(Boolean);
        if (disarmed !== null && pruned) swept = live;
      });
    },
  };
}
