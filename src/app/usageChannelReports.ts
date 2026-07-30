import { log } from "../ipc/log";
import { onUsageReport } from "../ipc/usage";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./sessionBinding";
import { reportUsage } from "./usageManager";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

/** Bridge reports into the usage store after live-membership and token checks. */
export function createUsageReportsLane({
  deck,
}: UsageLaneContext): UsageLane {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void onUsageReport(({ paneId, token, payload }) => {
    if (disposed) return;
    const livePanes = paneMembership(paneMembershipKey(deck.getSnapshot()));
    if (!livePanes.has(paneId)) {
      log.warn("web:bridge", `usage report for closed pane ${paneId} — ignored`);
      return;
    }
    if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
      log.warn(
        "web:bridge",
        `usage report for ${paneId} with a wrong token — ignored`,
      );
      return;
    }
    reportUsage(paneId, payload);
  })
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else unlisten = unsubscribe;
    })
    .catch((error) => {
      if (!disposed) {
        log.warn("web:bridge", `usage report listener failed: ${error}`);
      }
    });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unlisten?.();
    },
  };
}
