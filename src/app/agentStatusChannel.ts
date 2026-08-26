import type { AgentContribution } from "@keepdeck/plugin-api";
import { onAgentStatus } from "../ipc/status";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import type { AgentStatusTracker } from "./agentStatusTracker";
import type { DeckStore } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
import { paneAgentType } from "../domain/deck";
import { isNavigationKey } from "../domain/terminal";
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

/** The user's own keystrokes, per pane — the host's only evidence that a
 * HUMAN acted, and injected like every other signal so the composition root
 * names each lane that feeds the tracker. */
export interface PaneKeyPort {
  subscribe(
    listener: (paneId: string, data: string) => void,
  ): () => void;
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
  keys: PaneKeyPort,
  /** Answer a report that is also a QUESTION — a turn-end hook asking
   * whether mail is waiting. Called in the same breath as the fold, and
   * deliberately so: the pane's status and the decision to keep it running
   * are one answer, and two handlers would let a pane be marked finished by
   * one while the other was still deciding to keep it working. Absent in
   * tests and while the feature is off; a payload that asks nothing never
   * reaches it. */
  answerAsk: (paneId: string, payload: unknown) => void = () => {},
  /** Tell the mail side an answer is coming, BEFORE the fold that wakes its
   * subscribers — otherwise it types a nudge at a pane it is about to serve
   * for free. Returns the disarm; a payload that asks nothing arms nothing.
   * See [`MailService.expectAsk`] for why the fold cannot simply move. */
  expectAsk: (paneId: string, payload: unknown) => () => void = () => () => {},
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
    apply: (paneId, payload) => {
      // Fold FIRST: the answer may depend on what this very event just said
      // about the pane (a turn that has ended is a turn that can be told
      // to keep going), and reading a status one edge stale is exactly the
      // divergence one round trip exists to prevent.
      //
      // The fold's cost is that it wakes mail's own subscription in the same
      // breath, one call before the answer empties the queue — so the mail
      // side is told an answer is coming and stops typing at this pane until
      // it has. Marking it here rather than reordering the two: swapping them
      // would answer against a stale status, which is the divergence above.
      const answered = expectAsk(paneId, payload);
      try {
        tracker.report(paneId, payload);
        answerAsk(paneId, payload);
      } finally {
        answered();
      }
    },
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
  //
  // Escape is the one key whose meaning we cannot read: it answers codex's
  // "No, and tell Codex what to do differently", and it INTERRUPTS claude.
  // Both readings are handled without distinguishing them — this edge is
  // stamped when the key is pressed, so an abort's marker (which the tailer
  // stamps with its own, later time) is never absorbed as stale and still
  // settles the pane on "Interrupted". The cost is a moment of "Working"
  // in between.
  const unsubscribeKeys = keys.subscribe((paneId, data) => {
    // Same live-process requirement the report lane carries, for the same
    // reason: a key pressed at a pane whose session has not started goes
    // nowhere (the write is a no-op), so it answered nothing. The dead
    // cases need no check — the sweep above clears their activity outright.
    if (sessions.state(paneId).kind !== "live") return;
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
