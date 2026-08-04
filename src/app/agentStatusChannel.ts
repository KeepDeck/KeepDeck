import type { AgentContribution } from "@keepdeck/plugin-api";
import { onAgentStatus } from "../ipc/status";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import type { AgentStatusTracker } from "./agentStatusTracker";
import type { DeckStore } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
import { paneAgentType } from "../domain/deck";
import { isNavigationKey } from "../domain/terminal";
import { subscribePaneKeys } from "./paneKeys";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { createVerifiedPaneReports } from "./verifiedPaneReports";

export interface AgentStatusChannel {
  dispose(): void;
}

/** The slice of the session registry the channel needs: when processes
 * change, and whether one is dead. */
export interface SessionLivenessPort {
  subscribe(listener: () => void): () => void;
  state(paneId: string): { kind: string };
}

/**
 * App-lifetime wiring of agent status into the tracker — the sibling of
 * [`createUsageChannel`], with the same duties folded into one module
 * because status has no tails, no polling and no persistence:
 *
 * - plugin `status.normalize` declarations ⇄ tracker registrations;
 * - the user's own answer to a waiting agent, read off their keystrokes —
 *   the one edge minted from what the host SEES rather than from what an
 *   agent reports, because no CLI reports it;
 * - bridge reports through the shared verification — WITH the live-process
 *   requirement: activity is a claim about a running process, and a hook
 *   envelope that outlives its process (a Stop racing a crash) must not
 *   paint "finished" over the crash;
 * - tracker hygiene as panes close — and as PROCESSES die. "Activity
 *   describes a live process" is enforced here, at the store's edge, in
 *   both directions (ingest gate + death sweep), so no render surface has
 *   to re-derive liveness its own way. The registry flips to `exited`
 *   before any terminal sink hears about it, so the sweep also catches an
 *   exit whose TerminalPane happens to be unmounted.
 */
export function createAgentStatusChannel(
  deck: DeckStore,
  agents: ContributionRegistry<AgentContribution>,
  tracker: AgentStatusTracker,
  sessions: SessionLivenessPort,
  attribution: PaneAttribution,
): AgentStatusChannel {
  let disposed = false;
  let normalizerDisposers: (() => void)[] = [];
  let declaring = new Set<string>();

  const registerNormalizers = () => {
    const previous = declaring;
    for (const unregister of normalizerDisposers) unregister();
    normalizerDisposers = [];
    const current = new Set<string>();
    for (const { entry } of agents.list()) {
      if (!entry.status) continue;
      current.add(entry.id);
      normalizerDisposers.push(
        tracker.registerNormalizer(
          entry.id,
          entry.status.normalize,
        ),
      );
    }
    // An agent that LOST its status voice (plugin disabled) can never
    // resolve what it already said — its panes' activity would freeze at
    // the last edge for as long as the process lives, and every surface
    // would keep painting it. Silence over a frozen lie. A mere
    // re-activation replaces the normalizer and clears nothing.
    for (const agentId of previous) {
      if (current.has(agentId)) continue;
      for (const workspace of deck.getSnapshot().workspaces) {
        for (const pane of workspace.panes) {
          if (paneAgentType(pane) === agentId) tracker.clear(pane.id);
        }
      }
    }
    declaring = current;
  };
  registerNormalizers();
  const unsubscribeAgents = agents.subscribe(() => {
    if (!disposed) registerNormalizers();
  });

  const reports = createVerifiedPaneReports(deck, attribution, {
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

  // A dead process's activity is no longer a fact about the pane — clear
  // it the moment the registry says so. `exited` is the process that ran
  // and died; `failed` is the spawn that never made it — ingest accepts
  // reports while `starting` (a hook can beat the spawn promise), so a
  // rejected spawn can leave accepted activity behind, and without this
  // rung it would render forever. The orchestrator's own retire owns the
  // deliberate teardowns (suspend, close, restart).
  const clearDeadPanes = () => {
    for (const paneId of tracker.getSnapshot().panes.keys()) {
      const kind = sessions.state(paneId).kind;
      if (kind === "exited" || kind === "failed") tracker.clear(paneId);
    }
  };
  const unsubscribeSessions = sessions.subscribe(clearDeadPanes);
  clearDeadPanes();

  // The user's own answer. A CLI reports the question it parks on and never
  // the answer — measured on codex 0.146, the next hook after its approval
  // prompt is the approved tool's COMPLETION, and claude's normalizer states
  // the same gap — so a pane keeps claiming "Needs approval" for as long as
  // the approved command runs. This is the only edge the host mints from
  // what it SEES rather than from what an agent says, which is why it
  // belongs here beside the reports and not in a plugin.
  //
  // Reading the question back is not answering it, so navigation resolves
  // nothing; anything else the user presses does. Erring that way is
  // deliberate: a wait cleared early self-corrects on claude (its idle nudge
  // re-raises) and is settled by the agent's own edge on codex, while a wait
  // left standing over an answered prompt is the silent lie this exists to
  // remove.
  const unsubscribeKeys = subscribePaneKeys((paneId, data) => {
    if (!isNavigationKey(data)) tracker.answered(paneId);
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAgents();
      unsubscribeDeck();
      unsubscribeSessions();
      unsubscribeKeys();
      reports.dispose();
      for (const unregister of normalizerDisposers) unregister();
      normalizerDisposers = [];
    },
  };
}
