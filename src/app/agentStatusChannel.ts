import type { AgentContribution } from "@keepdeck/plugin-api";
import { log } from "../ipc/log";
import { onAgentStatus } from "../ipc/status";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import { agentStatusTracker } from "./agentStatusTracker";
import type { DeckStore } from "./deckStore";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./sessionBinding";

export interface AgentStatusChannel {
  dispose(): void;
}

/**
 * App-lifetime wiring of agent status into the tracker — the sibling of
 * [`createUsageChannel`], with the same duties folded into one module
 * because status has no tails, no polling and no persistence:
 *
 * - plugin `status.normalize` declarations ⇄ tracker registrations;
 * - bridge reports, token-verified, into the tracker;
 * - tracker hygiene as panes close.
 */
export function createAgentStatusChannel(
  deck: DeckStore,
  agents: ContributionRegistry<AgentContribution>,
): AgentStatusChannel {
  let disposed = false;
  let normalizerDisposers: (() => void)[] = [];

  const registerNormalizers = () => {
    for (const unregister of normalizerDisposers) unregister();
    normalizerDisposers = [];
    for (const { entry } of agents.list()) {
      if (!entry.status) continue;
      normalizerDisposers.push(
        agentStatusTracker.registerNormalizer(
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

  let unlisten: (() => void) | null = null;
  void onAgentStatus(({ paneId, token, payload }) => {
    if (disposed) return;
    const livePanes = paneMembership(paneMembershipKey(deck.getSnapshot()));
    if (!livePanes.has(paneId)) {
      log.warn(
        "web:bridge",
        `status report for closed pane ${paneId} — ignored`,
      );
      return;
    }
    if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
      log.warn(
        "web:bridge",
        `status report for ${paneId} with a wrong token — ignored`,
      );
      return;
    }
    agentStatusTracker.report(paneId, payload);
  })
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else unlisten = unsubscribe;
    })
    .catch((error) => {
      if (!disposed) {
        log.warn("web:bridge", `status report listener failed: ${error}`);
      }
    });

  let membershipKey: string | null = null;
  const retainLivePanes = () => {
    const nextKey = paneMembershipKey(deck.getSnapshot());
    if (nextKey === membershipKey) return;
    membershipKey = nextKey;
    agentStatusTracker.retain(paneMembership(nextKey));
  };
  const unsubscribeDeck = deck.subscribe(retainLivePanes);
  retainLivePanes();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAgents();
      unsubscribeDeck();
      unlisten?.();
      for (const unregister of normalizerDisposers) unregister();
      normalizerDisposers = [];
    },
  };
}
