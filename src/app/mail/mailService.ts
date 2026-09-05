/**
 * The feature, as ONE thing to build — and one thing to take down.
 *
 * Mail has two halves that fail differently: SENDING is a command an agent
 * calls, and DELIVERY is the deck writing into a pane. Owned apart, a
 * teardown could leave a pane receiving messages it has no way to answer —
 * so both halves hang off the same owner here, built together for the life
 * of the app and disposed whole.
 *
 * That is also why the commands are registered from here rather than added
 * to the core set: a registered command IS an MCP tool
 * (`src/app/mcp/index.ts` projects the registry), and a tool must exist for
 * exactly as long as the thing behind it — `mail.send` registered over a
 * disposed manager would advertise a capability that refuses every call.
 *
 * Everything the feature is made of composes INSIDE this file: the queue
 * owner, the commands, the two delivery channels, the labelled channel's
 * reply memory, and the presence that re-states a pane's standing. The
 * composition root gets one create and one dispose. It held them all once —
 * two creates, two disposes, four registry lookups and a private fan-out —
 * and the cost was not tidiness: a teardown destroyed the manager while a
 * collaborator built beside it kept running, and nothing in this directory
 * could enforce otherwise, because the collaborator was not its child.
 */
import type { AgentStatus } from "@keepdeck/plugin-api";
import type { CommandRegistry } from "../../domain/commands";
import type { Workspace } from "../../domain/deck";
import { teamMembers } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { correlationOf, createHookReplies, type HookReplies } from "./hookReply";
import { registerMailCommands, type MailCommandDeps } from "./mailCommands";
import { createMailManager, type MailManager } from "./mailManager";
import { createMailWake } from "./wakeChannel";
import { createTeamPresence } from "./teamPresence";

/**
 * What mail cannot build for itself.
 *
 * Every member is a port onto something the app owns elsewhere — the deck,
 * the plugin registries, the status lane, the terminal, the bridge. Nothing
 * here is a piece OF the feature; those are all built below.
 */
export interface MailServiceDeps {
  registry: CommandRegistry;
  deck: {
    workspaces(): readonly Workspace[];
    subscribe(listener: () => void): () => void;
    setPaneTeam: MailCommandDeps["setPaneTeam"];
    /** Which CLI a pane runs, or null when the deck no longer holds it. */
    agentTypeOf(paneId: string): string | null;
  };
  agents: {
    /** How a pane reads, for anything that has to name one. */
    labels: MailCommandDeps["agents"];
    /** What an agent's plugin contributes about mail — read PER CALL: a
     * plugin can be enabled or disabled while the deck is up, and a pane can
     * be restarted onto another agent. */
    statusOf(agentId: string): AgentStatus | undefined;
    /** What that agent's own binary answered to `--version`, or null. A
     * hook-output schema belongs to a RELEASE, so a renderer may need it. */
    versionOf(agentId: string): string | null;
    /** Every change to the set of agent plugins — one registered, one
     * uninstalled, a Rescan re-activating them all. That is when a version
     * can become knowable (the registry was empty at boot) or become STALE
     * (a Rescan forgets what it cached, because the CLI may have been
     * upgraded under a running app). */
    onAgentsChanged(listener: () => void): () => void;
    /** Go and find that out, if nobody has yet.
     *
     * Returns nothing on purpose: it must be impossible to await. Asking a
     * CLI its version RUNS it — half a second, once — and this is the only
     * feature that ever reads the answer, so the question is asked here
     * rather than at boot for everyone. Until it lands `versionOf` says
     * null, which every renderer already reads as "assume the current
     * schema". */
    learnVersion(agentId: string): void;
  };
  status: {
    activityOf(paneId: string): PaneActivity | undefined;
    subscribe(listener: () => void): () => void;
    /** A pane whose context was rebuilt has forgotten where it stands. */
    onContextRebuilt(listener: (paneId: string) => void): () => void;
  };
  /** When a pane's input channel appears — see `createMailManager`. */
  subscribeChannels(listener: () => void): () => void;
  /** A pane whose agent started a conversation with no memory of the last. */
  onSessionBegan(listener: (paneId: string) => void): () => void;
  /** The role catalog changed under every live team at once — the standing
   * presence re-states each member's briefing. */
  onRoleCatalogChanged(listener: () => void): () => void;
  terminal: {
    wake(paneId: string): boolean;
  };
  bridge: {
    /** Answers whether the reply reached the waiting hook. False means those
     * messages went nowhere and are still the deck's to put back. */
    reply(paneId: string, correlation: string, body: string): Promise<boolean>;
    nudge(paneId: string): void;
  };
}

export interface MailService {
  /** The live manager, or null once disposed. The lifecycle owners (pane
   * retire, close) reach it through this rather than holding a reference
   * that outlives the service. */
  current(): MailManager | null;
  /** Answer one asking payload from a pane's reporter. Handed to the status
   * lane, which is where the question arrives. */
  answerAsk(paneId: string, payload: unknown): void;
  /**
   * Declare that this envelope is about to be ANSWERED, before anything else
   * reacts to it. Returns the disarm; a payload that asks nothing arms
   * nothing and disarms nothing.
   *
   * It exists because of an order that is right for a different reason. The
   * status lane folds an envelope BEFORE answering it, so the answer reads a
   * fresh status — and the fold, synchronously, wakes everything subscribed
   * to activity, this manager included. A pane whose turn just ended looks
   * idle with mail queued, so the pass types a nudge at it, and only then
   * does the same envelope hand that mail over through the hook for free.
   * Observed on 42 of 188 nudged messages: a line left in a composer for a
   * message that was already leaving by another door.
   *
   * Between these two calls the terminal leg of `wake` refuses. Nothing else
   * changes: the bridge doorbell is untouched, the queue is untouched, and a
   * hand-over that fails leaves the message exactly where a refused wake
   * leaves it.
   */
  expectAsk(paneId: string, payload: unknown): () => void;
  dispose(): void;
}

export function createMailService(deps: MailServiceDeps): MailService {
  let disposed = false;
  /** Panes whose asking envelope is being answered RIGHT NOW — see
   * [`MailService.expectAsk`]. Never more than one at a time in practice:
   * the transport holds a slot per pane and correlation. */
  const answering = new Set<string>();

  /** What THIS pane's agent contributes about mail. */
  const statusOfPane = (paneId: string): AgentStatus | undefined => {
    const agentType = deps.deck.agentTypeOf(paneId);
    return agentType ? deps.agents.statusOf(agentType) : undefined;
  };

  /** The panes that exist right now. Sweeping is CORRECTNESS, not hygiene:
   * `pane-N` is a reusable slot, so a queue left behind by a closed pane
   * would be handed to whoever inherits its number. */
  const livePaneIds = () =>
    new Set(
      deps.deck
        .workspaces()
        .flatMap((workspace) => workspace.panes.map((pane) => pane.id)),
    );

  /**
   * Make sure we know the CLI version of every agent currently on the deck.
   *
   * Asked HERE because mail is the only thing that reads it — a renderer
   * picking the hook-output schema its release accepts. Asking at boot for
   * every installed plugin instead cost every user about two seconds of
   * blocked window, most of them for a fact nothing would ever read.
   *
   * Fire and forget, and deliberately NOT memoised here. The port already
   * answers from its own cache, and that cache is the only thing that knows
   * when the answer stopped being true: a re-detection drops it, because the
   * CLI underneath may have been upgraded. A second memo on this side was
   * invalidated by a different signal than the cache it shadowed, so after a
   * Rescan it went on reporting "already asked" about a version that had
   * just been thrown away — and nothing ever asked again.
   *
   * The cost of not memoising is two array `find`s and a capability check
   * per distinct agent type per notification, against a correctness hole.
   */
  const learnLiveVersions = () => {
    const seen = new Set<string>();
    for (const workspace of deps.deck.workspaces()) {
      for (const pane of workspace.panes) {
        const agentType = deps.deck.agentTypeOf(pane.id);
        if (!agentType || seen.has(agentType)) continue;
        seen.add(agentType);
        deps.agents.learnVersion(agentType);
      }
    }
  };

  const hookReplies: HookReplies = createHookReplies({
    mail: () => manager,
    rendererFor: (agentId) => deps.agents.statusOf(agentId)?.renderMail,
    versionOf: deps.agents.versionOf,
    reply: deps.bridge.reply,
  });

  // Re-states a pane's standing whenever its memory of it may have gone — a
  // fresh conversation, or a compaction. Built below and torn down with
  // everything else, so a disposed service leaves no subscription at all
  // rather than a live one whose every announcement lands on a dead manager.
  const startPresence = () =>
    createTeamPresence({
      standingOf: (paneId) => {
        for (const workspace of deps.deck.workspaces()) {
          const pane = workspace.panes.find(
            (candidate) => candidate.id === paneId,
          );
          if (!pane?.team) continue;
          const name = pane.team.name;
          return {
            team: name,
            role: pane.team.role,
            everyRole: teamMembers(workspace, name)
              .map((member) => member.team?.role)
              .filter((role): role is string => Boolean(role)),
          };
        }
        return null;
      },
      announce: (paneId, body) => manager.announce(paneId, "team", body),
      onSessionBegan: deps.onSessionBegan,
      onContextRebuilt: deps.status.onContextRebuilt,
      onCatalogChanged: deps.onRoleCatalogChanged,
      onRosterChanged: deps.deck.subscribe,
      teamedPanes: () =>
        deps.deck
          .workspaces()
          .flatMap((workspace) =>
            workspace.panes.filter((pane) => pane.team).map((pane) => pane.id),
          ),
    });

  const manager = createMailManager({
    activityOf: deps.status.activityOf,
    subscribeActivity: deps.status.subscribe,
    subscribeChannels: deps.subscribeChannels,
    wake: createMailWake({
      channelOf: (paneId) => statusOfPane(paneId)?.wake,
      // Refuse while this pane's own asking envelope is mid-answer: the
      // words are already leaving through the hook, and a line typed now
      // says nothing and stays. A refusal keeps the message queued, which
      // is exactly where the hand-over is about to find it.
      throughTerminal: (paneId) =>
        answering.has(paneId) ? false : deps.terminal.wake(paneId),
      throughBridge: deps.bridge.nudge,
    }),
    // A pane whose CLI plugin renders mail will come asking at its turn
    // boundary, so a running turn is worth waiting out for the labelled
    // channel.
    asksAtTurnEnd: (paneId) => Boolean(statusOfPane(paneId)?.renderMail),
  });
  const unregister = registerMailCommands(deps.registry, {
    workspaces: deps.deck.workspaces,
    agents: deps.agents.labels,
    setPaneTeam: deps.deck.setPaneTeam,
    mail: manager,
  });
  const presence = startPresence();
  learnLiveVersions();

  // Swept on every deck change rather than at close: a pane can also leave by
  // a workspace closing, and one sweep covers both.
  const unsubscribePanes = deps.deck.subscribe(() => {
    manager.retain(livePaneIds());
    // A pane that just appeared may run an agent nobody has asked about.
    learnLiveVersions();
  });
  // The registry is EMPTY while the deck hydrates, so the walk above finds
  // nothing to ask about — and without this the answer was only ever learned
  // by the coincidence that waking a restored pane happens to write to the
  // deck. A Rescan is NOT this edge: it re-activates plugins that are already
  // active, which adds no contribution and notifies nobody. What covers a
  // Rescan is the port forgetting what it cached, so the next deck change
  // asks again.
  const unsubscribeAgents = deps.agents.onAgentsChanged(learnLiveVersions);

  return {
    current: () => (disposed ? null : manager),
    answerAsk: hookReplies.answer,
    expectAsk(paneId, payload) {
      if (!correlationOf(payload)) return () => {};
      answering.add(paneId);
      return () => {
        if (!answering.delete(paneId)) return;
        // A pass that ran while we refused reached no conclusion, and a
        // refusal arms no timer — so the walk has to be re-run by hand. The
        // usual case finds an empty queue and does nothing; the case that
        // matters is a hand-over that gave the messages back, which must not
        // sit on an idle pane until something else happens to drive a pass.
        manager.reconsider();
      };
    },
    /**
     * Take the feature down, in the one order that is safe.
     *
     * The service's own subscriptions first, so nothing drives the manager
     * while it goes. Then the commands: an in-flight call must not reach a
     * manager that is already disposed, and unregistering is what makes the
     * tool stop existing for anyone still holding a `tools/list` from a
     * moment ago. Then the presence, so nothing announces into what is
     * about to go. Then the manager itself.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePanes();
      unsubscribeAgents();
      unregister();
      presence.dispose();
      manager.dispose();
    },
  };
}
