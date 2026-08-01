import type { AgentContribution } from "@keepdeck/plugin-api";
import { onAgentStatus } from "../ipc/status";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import type { AgentStatusTracker } from "./agentStatusTracker";
import type { DeckStore } from "./deckStore";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { createVerifiedPaneReports } from "./verifiedPaneReports";

export interface AgentStatusChannel {
  dispose(): void;
}

/**
 * App-lifetime wiring of agent status into the tracker — the sibling of
 * [`createUsageChannel`], with the same duties folded into one module
 * because status has no tails, no polling and no persistence:
 *
 * - plugin `status.normalize` declarations ⇄ tracker registrations;
 * - bridge reports through the shared verification — WITH the live-process
 *   requirement: activity is a claim about a running process, and a hook
 *   envelope that outlives its process (a Stop racing a crash) must not
 *   paint "finished" over the crash;
 * - tracker hygiene as panes close.
 */
export function createAgentStatusChannel(
  deck: DeckStore,
  agents: ContributionRegistry<AgentContribution>,
  tracker: AgentStatusTracker,
): AgentStatusChannel {
  let disposed = false;
  let normalizerDisposers: (() => void)[] = [];

  const registerNormalizers = () => {
    for (const unregister of normalizerDisposers) unregister();
    normalizerDisposers = [];
    for (const { entry } of agents.list()) {
      if (!entry.status) continue;
      normalizerDisposers.push(
        tracker.registerNormalizer(
          entry.id,
          entry.status.normalize,
        ),
      );
    }
  };
  registerNormalizers();
  const unsubscribeAgents = agents.subscribe(() => {
    if (!disposed) registerNormalizers();
  });

  const reports = createVerifiedPaneReports(deck, {
    label: "status report",
    subscribe: onAgentStatus,
    requireLiveProcess: true,
    apply: (paneId, payload) => tracker.report(paneId, payload),
  });

  let membershipKey: string | null = null;
  const retainLivePanes = () => {
    const nextKey = paneMembershipKey(deck.getSnapshot());
    if (nextKey === membershipKey) return;
    membershipKey = nextKey;
    tracker.retain(paneMembership(nextKey));
  };
  const unsubscribeDeck = deck.subscribe(retainLivePanes);
  retainLivePanes();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAgents();
      unsubscribeDeck();
      reports.dispose();
      for (const unregister of normalizerDisposers) unregister();
      normalizerDisposers = [];
    },
  };
}
