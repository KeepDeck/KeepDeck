/**
 * The feature, as one switchable thing — and as ONE thing to build.
 *
 * Mail has two halves that fail differently: SENDING is a command an agent
 * calls, and DELIVERY is the deck writing into a pane. A gate over only the
 * first would leave a pane receiving messages it has no way to answer, which
 * is worse than the feature being off — so both halves hang off the same
 * owner here, and the toggle creates or destroys it whole.
 *
 * That is also why the commands are registered from here rather than added
 * to the core set: a registered command IS an MCP tool
 * (`src/app/mcp/index.ts` projects the registry), so leaving `mail.send`
 * registered-but-refusing would advertise a capability the deck has switched
 * off. Unregistering removes it from `tools/list` instead, which is what an
 * agent can actually act on.
 *
 * Everything the feature is made of composes INSIDE this file: the queue
 * owner, the commands, the two delivery channels, the labelled channel's
 * reply memory, and the presence that re-states a pane's standing. The
 * composition root gets one create and one dispose. It held them all once —
 * two creates, two disposes, four registry lookups and a private fan-out —
 * and the cost was not tidiness: turning the feature off destroyed the
 * manager while a collaborator built beside it kept running, and nothing in
 * this directory could enforce otherwise, because the collaborator was not
 * its child.
 *
 * The live-toggle shape mirrors `createMcpService`: a policy that reads the
 * setting and reports changes, and an owner that settles to it.
 */
import type { AgentStatus } from "@keepdeck/plugin-api";
import type { CommandRegistry } from "../../domain/commands";
import type { Workspace } from "../../domain/deck";
import { teamMembers, type Mail } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import type { Deck } from "../useDeck";
import { describeError, log } from "../../ipc/log";
import { createHookReplies, type HookReplies } from "./hookReply";
import { registerMailCommands, type MailCommandDeps } from "./mailCommands";
import { createMailManager, type MailManager } from "./mailManager";
import { createMailWake } from "./wakeChannel";
import { createTeamPresence } from "./teamPresence";

export interface MailPolicy {
  /** The wish, or null while settings have not loaded. */
  agentTeams(): boolean | null;
  subscribe(listener: () => void): () => void;
}

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
    /** The commands' view of the deck, already shaped for them. */
    surface(): Deck;
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
  terminal: {
    deliver(mail: Mail): boolean;
    wake(paneId: string): boolean;
  };
  bridge: {
    reply(paneId: string, correlation: string, body: string): void;
    nudge(paneId: string): void;
    /** An answer nobody read: its messages must go back in the queue. */
    onReplyUncollected(
      handler: (reply: { pane: string; id: string }) => void,
    ): Promise<() => void>;
  };
}

export interface MailService {
  /** The live manager, or null while the feature is off. The lifecycle
   * owners (pane retire, close) reach it through this rather than holding a
   * reference that outlives a toggle. */
  current(): MailManager | null;
  /** Answer one asking payload from a pane's reporter. Handed to the status
   * lane, which is where the question arrives. */
  answerAsk(paneId: string, payload: unknown): void;
  dispose(): void;
}

export function createMailService(
  policy: MailPolicy,
  deps: MailServiceDeps,
): MailService {
  let manager: MailManager | null = null;
  let unregister: (() => void) | null = null;
  let presence: { dispose(): void } | null = null;
  let disposed = false;

  /** What THIS pane's agent contributes about mail. */
  const statusOfPane = (paneId: string): AgentStatus | undefined => {
    const agentType = deps.deck.agentTypeOf(paneId);
    return agentType ? deps.agents.statusOf(agentType) : undefined;
  };

  /** The panes that exist right now. Sweeping is CORRECTNESS, not hygiene:
   * `pane-N` is a reusable slot, so a queue or inbox left behind by a closed
   * pane would be handed to whoever inherits its number. */
  const livePaneIds = () =>
    new Set(
      deps.deck
        .workspaces()
        .flatMap((workspace) => workspace.panes.map((pane) => pane.id)),
    );

  const hookReplies: HookReplies = createHookReplies({
    mail: () => manager,
    rendererFor: (agentId) => deps.agents.statusOf(agentId)?.renderMail,
    versionOf: deps.agents.versionOf,
    reply: deps.bridge.reply,
  });

  // Re-states a pane's standing whenever its memory of it may have gone — a
  // fresh conversation, or a compaction. Built by `settle` and torn down with
  // everything else, so the feature being off means no subscription at all
  // rather than a live one whose every announcement lands on a null manager.
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
      announce: (paneId, body) => manager?.announce(paneId, "team", body),
      onSessionBegan: deps.onSessionBegan,
      onContextRebuilt: deps.status.onContextRebuilt,
    });

  function settle(): void {
    if (disposed) return;
    // `null` (settings still loading) is treated as off: starting the
    // feature on a guess and tearing it down a moment later would deliver
    // into panes the user may have meant to leave alone.
    const wanted = policy.agentTeams() === true;
    if (wanted === (manager !== null)) return;
    if (wanted) {
      manager = createMailManager({
        activityOf: deps.status.activityOf,
        subscribeActivity: deps.status.subscribe,
        subscribeChannels: deps.subscribeChannels,
        deliver: deps.terminal.deliver,
        wake: createMailWake({
          channelOf: (paneId) => statusOfPane(paneId)?.wake,
          throughTerminal: deps.terminal.wake,
          throughBridge: deps.bridge.nudge,
        }),
        // A pane whose CLI plugin renders mail will come asking at its turn
        // boundary, so a running turn is worth waiting out for the labelled
        // channel.
        asksAtTurnEnd: (paneId) => Boolean(statusOfPane(paneId)?.renderMail),
      });
      unregister = registerMailCommands(deps.registry, {
        deck: deps.deck.surface,
        agents: deps.agents.labels,
        setPaneTeam: deps.deck.setPaneTeam,
        mail: manager,
      });
      presence = startPresence();
      return;
    }
    // Commands first: an in-flight call must not reach a manager that is
    // already disposed, and unregistering is what makes the tool stop
    // existing for anyone still holding a `tools/list` from a moment ago.
    unregister?.();
    unregister = null;
    presence?.dispose();
    presence = null;
    // The queues these messages were taken from are about to go. Forgetting
    // them is what stops a late report putting mail the user cleared into
    // whatever queue exists next time.
    hookReplies.forgetAll();
    manager?.dispose();
    manager = null;
  }

  const unsubscribeSettings = policy.subscribe(settle);
  // Swept on every deck change rather than at close: a pane can also leave by
  // a workspace closing, and one sweep covers both. Cheap when the feature is
  // off — there is no manager to sweep.
  const unsubscribePanes = deps.deck.subscribe(() => {
    manager?.retain(livePaneIds());
  });
  let stopUncollected: (() => void) | null = null;
  void deps.bridge
    .onReplyUncollected(({ pane, id }) => hookReplies.uncollected(pane, id))
    .then((stop) => {
      // Disposed while the subscription was still being set up: stop it
      // rather than leave a listener behind a dead service.
      if (disposed) stop();
      else stopUncollected = stop;
    })
    .catch((error: unknown) => {
      // Without it, an answer nobody reads is simply lost — the same outcome
      // as before this report existed. Mail keeps working; say so once
      // rather than take the feature down over a listener.
      log.warn(
        "web:mail",
        `no report of unread answers: ${describeError(error)}`,
      );
    });
  settle();

  return {
    current: () => manager,
    answerAsk: hookReplies.answer,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSettings();
      unsubscribePanes();
      stopUncollected?.();
      presence?.dispose();
      presence = null;
      unregister?.();
      unregister = null;
      hookReplies.forgetAll();
      manager?.dispose();
      manager = null;
    },
  };
}
