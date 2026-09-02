import type { TailWatch, UsageNormalizer } from "@keepdeck/plugin-api";
import { paneAgentType } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { readStoreCold } from "../ipc/usage";
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
  const swept = new Set<string>();
  let membershipKey: string | null = null;

  /**
   * The boot catch-up, over whichever agents asked for one.
   *
   * An agent that also runs outside KeepDeck can have spent quota this deck
   * never saw, so its own files can know fresher account limits than the
   * persisted snapshot. This used to find that agent BY NAME and ask a
   * command that knew where it keeps its files; both facts went home, and
   * what is left here is the part that was always the host's — reading
   * candidates in order until a normalizer makes a claim, then stopping.
   */
  const sweepDeclaredStores = () => {
    if (disposed) return;
    for (const [agentId, declared] of declarations.current()) {
      const sweep = declared.tail?.sweep;
      if (!sweep || swept.has(agentId)) continue;
      // Marked before the walk, not after: a sweep is once per session, and
      // a reconcile firing mid-walk must not start a second one.
      swept.add(agentId);
      void sweepAgent(agentId, declared, sweep).catch((error) =>
        log.debug(
          "web:usage",
          `${agentId} boot sweep failed: ${describeError(error)}`,
        ),
      );
    }
  };

  const sweepAgent = async (
    agentId: string,
    declared: { normalize: UsageNormalizer; tail?: { watches: readonly TailWatch[] } },
    sweep: () => Promise<readonly string[]>,
  ) => {
    const watches = declared.tail?.watches ?? [];
    for (const path of await sweep()) {
      if (disposed) return;
      const read = await readStoreCold(path, watches);
      // Nothing this agent asked for is in that file — an ordinary answer,
      // and the reason a sweep hands back a LIST: a just-launched session
      // writes its store before it has anything to say.
      if (!read) continue;
      const receivedAt = Date.now();
      let claimed = false;
      for (const record of read.records) {
        const sourceAt =
          usageSourceTimestamp(record.sourceAt, receivedAt) ??
          usageSourceTimestamp(read.mtimeMs, receivedAt) ??
          0;
        const result = declared.normalize(
          { agent: agentId, event: record.event, catchUp: true },
          sourceAt,
        );
        if (result?.account) {
          usage.setAccount(agentId, result.account);
          claimed = true;
        }
      }
      if (claimed) return;
    }
    log.debug("web:usage", `boot sweep: no ${agentId} store carries an account`);
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
  const unsubscribeDeclarations = declarations.subscribe(sweepDeclaredStores);
  const unsubscribeUsage = usage.subscribe(captureHistory);
  retainLivePanes();
  sweepDeclaredStores();
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
