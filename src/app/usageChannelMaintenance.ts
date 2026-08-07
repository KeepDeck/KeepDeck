import { paneAgentType } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { latestCodexRollout } from "../ipc/usage";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import {
  peekPaneSpawnSpec,
  spawnPlanInheritsSession,
  spawnPlanNeedsUsageBaseline,
} from "./spawnSpecs";
import {
  recordPaneUsage,
  type UsageSessionOrigin,
} from "./usageHistoryManager";
import { usageSourceTimestamp } from "./usageProvenance";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

/** Account boot catch-up, pane retention and durable history capture. */
export function createUsageMaintenanceLane({
  deck,
  declarations,
  usage,
  attribution,
}: UsageLaneContext): UsageLane {
  let disposed = false;
  let sweptCodex = false;
  let membershipKey: string | null = null;

  const sweepNewestCodex = () => {
    if (sweptCodex || disposed) return;
    const found = [...declarations.current()].find(
      ([, declared]) => declared.tail === "codex",
    );
    if (!found) return;
    sweptCodex = true;
    const [agentId, declared] = found;
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
        const result = declared.normalize(
          { agent: agentId, event: rollout.event, catchUp: true },
          sourceAt,
        );
        if (result?.account) usage.setAccount(agentId, result.account);
      })
      .catch((error) =>
        log.debug("web:usage", `codex boot sweep failed: ${error}`),
      );
  };

  const retainLivePanes = () => {
    const nextKey = paneMembershipKey(deck.getSnapshot());
    if (nextKey === membershipKey) return;
    membershipKey = nextKey;
    const live = paneMembership(nextKey);
    usage.retainPanes(live);
    // Per-pane state is retired by the deck's membership as well as by a
    // process ending, and the attribution ledger holds per-pane state: left
    // out of this half it would be the one map that only ever grows.
    attribution.forget(live);
  };

  const captureHistory = () => {
    const current = deck.getSnapshot();
    for (const [paneId, paneUsage] of usage.getSnapshot().panes) {
      const workspace = current.workspaces.find((candidate) =>
        candidate.panes.some((pane) => pane.id === paneId),
      );
      const pane = workspace?.panes.find(
        (candidate) => candidate.id === paneId,
      );
      if (!workspace || !pane || paneAgentType(pane) !== paneUsage.agent) {
        continue;
      }
      const sessionId = paneUsage.sessionId ?? pane.session?.id;
      if (!sessionId) continue;
      // A pane with NO cached plan is one this run did not spawn — attached
      // or restored across a restart — so its session may predate the run.
      // `fresh` needs POSITIVE evidence that this run's own spawn minted the
      // session, never merely the absence of a match: a plan that inherits
      // from something answers `unknown` until the id it inherits is known.
      const spec = peekPaneSpawnSpec(paneId);
      const origin: UsageSessionOrigin = spawnPlanNeedsUsageBaseline(
        spec,
        sessionId,
      )
        ? "inherited"
        : spec && !spawnPlanInheritsSession(spec)
          ? "fresh"
          : "unknown";
      const index = workspace.panes.indexOf(pane);
      void recordPaneUsage(paneUsage, {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceCwd: workspace.cwd,
        paneId,
        paneName: pane.name ?? pane.autoTitle ?? `Agent ${index + 1}`,
        sessionId,
        origin,
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
  const unsubscribeUsage = usage.subscribe(captureHistory);
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
