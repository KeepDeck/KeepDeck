import { paneAgentType } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { latestCodexRollout } from "../ipc/usage";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import {
  peekPaneSpawnSpec,
  spawnPlanNeedsUsageBaseline,
} from "./spawnSpecs";
import {
  getUsageSnapshot,
  retainUsagePanes,
  setAccountUsage,
  subscribeUsage,
} from "./usageManager";
import { recordPaneUsage } from "./usageHistoryManager";
import { usageSourceTimestamp } from "./usageProvenance";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

/** Account boot catch-up, pane retention and durable history capture. */
export function createUsageMaintenanceLane({
  deck,
  declarations,
}: UsageLaneContext): UsageLane {
  let disposed = false;
  let sweptCodex = false;
  let membershipKey: string | null = null;

  const sweepNewestCodex = () => {
    if (sweptCodex || disposed) return;
    const found = [...declarations.current()].find(
      ([, usage]) => usage.tail === "codex",
    );
    if (!found) return;
    sweptCodex = true;
    const [agentId, usage] = found;
    void latestCodexRollout()
      .then((rollout) => {
        if (disposed || !rollout) {
          if (!rollout) {
            log.debug(
              "web:usage",
              "boot sweep: no codex rollout carries usage",
            );
          }
          return;
        }
        const receivedAt = Date.now();
        const sourceAt =
          usageSourceTimestamp(rollout.sourceAt, receivedAt) ??
          usageSourceTimestamp(rollout.mtimeMs, receivedAt) ??
          0;
        const result = usage.normalize(
          { agent: agentId, event: rollout.event, catchUp: true },
          sourceAt,
        );
        if (result?.account) setAccountUsage(agentId, result.account);
      })
      .catch((error) =>
        log.debug("web:usage", `codex boot sweep failed: ${error}`),
      );
  };

  const retainLivePanes = () => {
    const nextKey = paneMembershipKey(deck.getSnapshot());
    if (nextKey === membershipKey) return;
    membershipKey = nextKey;
    retainUsagePanes(paneMembership(nextKey));
  };

  const captureHistory = () => {
    const current = deck.getSnapshot();
    for (const [paneId, usage] of getUsageSnapshot().panes) {
      const workspace = current.workspaces.find((candidate) =>
        candidate.panes.some((pane) => pane.id === paneId),
      );
      const pane = workspace?.panes.find(
        (candidate) => candidate.id === paneId,
      );
      if (!workspace || !pane || paneAgentType(pane) !== usage.agent) continue;
      const sessionId = usage.sessionId ?? pane.session?.id;
      if (!sessionId) continue;
      const baselineOnly = spawnPlanNeedsUsageBaseline(
        peekPaneSpawnSpec(paneId),
        sessionId,
      );
      const index = workspace.panes.indexOf(pane);
      void recordPaneUsage(usage, {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceCwd: workspace.cwd,
        paneId,
        paneName: pane.name ?? pane.autoTitle ?? `Agent ${index + 1}`,
        sessionId,
        ...(baselineOnly ? { baselineOnly: true } : {}),
        ...(pane.cwd
          ? {
              worktree: {
                path: pane.cwd,
                repo: workspace.cwd,
                ...(pane.branch ? { branch: pane.branch } : {}),
              },
            }
          : {}),
      }).catch((error) =>
        log.warn(
          "web:usage",
          `usage history append failed: ${describeError(error)}`,
        ),
      );
    }
  };

  const unsubscribeDeck = deck.subscribe(retainLivePanes);
  const unsubscribeDeclarations = declarations.subscribe(sweepNewestCodex);
  const unsubscribeUsage = subscribeUsage(captureHistory);
  retainLivePanes();
  sweepNewestCodex();
  captureHistory();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeDeck();
      unsubscribeDeclarations();
      unsubscribeUsage();
    },
  };
}
