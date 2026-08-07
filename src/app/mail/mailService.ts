/**
 * The feature, as one switchable thing.
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
 * The live-toggle shape mirrors `createMcpService`: a policy that reads the
 * setting and reports changes, and an owner that settles to it.
 */
import type { CommandRegistry } from "../../domain/commands";
import type { Mail } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { registerMailCommands, type MailCommandDeps } from "./mailCommands";
import { createMailManager, type MailManager } from "./mailManager";

export interface MailPolicy {
  /** The wish, or null while settings have not loaded. */
  agentTeams(): boolean | null;
  subscribe(listener: () => void): () => void;
}

export interface MailServiceDeps {
  registry: CommandRegistry;
  activityOf(paneId: string): PaneActivity | undefined;
  subscribeActivity(listener: () => void): () => void;
  deliver(mail: Mail): boolean;
  /** Whether this pane's agent asks the deck for its mail at a turn
   * boundary — see `createMailManager`. */
  asksAtTurnEnd?(paneId: string): boolean;
  /** The panes that exist right now, and a way to hear about changes.
   * Sweeping is CORRECTNESS, not hygiene: `pane-N` is a reusable slot, so a
   * queue or inbox left behind by a closed pane would be handed to whoever
   * inherits its number. */
  livePaneIds(): ReadonlySet<string>;
  subscribePanes(listener: () => void): () => void;
  /** Everything the commands need that is not the manager itself. */
  commands: Omit<MailCommandDeps, "mail">;
}

export interface MailService {
  /** The live manager, or null while the feature is off. The lifecycle
   * owners (pane retire, close) reach it through this rather than holding a
   * reference that outlives a toggle. */
  current(): MailManager | null;
  dispose(): void;
}

export function createMailService(
  policy: MailPolicy,
  deps: MailServiceDeps,
): MailService {
  let manager: MailManager | null = null;
  let unregister: (() => void) | null = null;
  let disposed = false;

  function settle(): void {
    if (disposed) return;
    // `null` (settings still loading) is treated as off: starting the
    // feature on a guess and tearing it down a moment later would deliver
    // into panes the user may have meant to leave alone.
    const wanted = policy.agentTeams() === true;
    if (wanted === (manager !== null)) return;
    if (wanted) {
      manager = createMailManager({
        activityOf: deps.activityOf,
        subscribeActivity: deps.subscribeActivity,
        deliver: deps.deliver,
        ...(deps.asksAtTurnEnd ? { asksAtTurnEnd: deps.asksAtTurnEnd } : {}),
      });
      unregister = registerMailCommands(deps.registry, {
        ...deps.commands,
        mail: manager,
      });
      return;
    }
    // Commands first: an in-flight call must not reach a manager that is
    // already disposed, and unregistering is what makes the tool stop
    // existing for anyone still holding a `tools/list` from a moment ago.
    unregister?.();
    unregister = null;
    manager?.dispose();
    manager = null;
  }

  const unsubscribeSettings = policy.subscribe(settle);
  // Swept on every deck change rather than at close: a pane can also leave by
  // a workspace closing, and one sweep covers both. Cheap when the feature is
  // off — there is no manager to sweep.
  const unsubscribePanes = deps.subscribePanes(() => {
    manager?.retain(deps.livePaneIds());
  });
  settle();

  return {
    current: () => manager,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSettings();
      unsubscribePanes();
      unregister?.();
      unregister = null;
      manager?.dispose();
      manager = null;
    },
  };
}
