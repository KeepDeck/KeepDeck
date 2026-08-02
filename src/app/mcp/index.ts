import type { CommandRegistry, CommandSource } from "../../domain/commands";
import {
  handleMcpLine,
  type McpCommandPort,
  type McpServerIdentity,
} from "../../domain/mcp";
import { fetchAppInfo } from "../../ipc/app";
import { mcpDisable, mcpEnable } from "../../ipc/mcp";
import { commands } from "../commandRegistry";
import {
  createMcpInjection,
  type McpInjection,
  type McpInjectionDeps,
} from "./injection";
import { createMcpRequestPump, type McpPumpPorts } from "./pump";
import {
  createMcpServerPolicy,
  type McpServerPolicy,
  type McpSettingsPort,
  type McpTransition,
  type McpTransportPort,
} from "./policy";

/** What the app knows about the transport as of the LAST SETTLED
 * transition — confirmed by the backend, not wished by the setting, and
 * not re-probed in between. `socket` is the served path the backend last
 * confirmed; `error` is why the last transition failed — and after a
 * failure the socket claim is KEPT, because nothing confirmed a change
 * (a failed disable most likely leaves the socket serving). */
/** The transport every external call is journaled under. */
const MCP_TRANSPORT = "mcp";

/** Whether two refusal lists say the same thing. Content, not length: the
 * same directory can refuse for a different reason, and the reason is the
 * whole message the settings page carries. */
function sameRefusals(
  next: readonly { root: string; reason: string }[],
  previous: readonly { root: string; reason: string }[],
): boolean {
  return (
    next.length === previous.length &&
    next.every((refusal, i) => {
      const before = previous[i];
      return (
        before !== undefined &&
        refusal.root === before.root &&
        refusal.reason === before.reason
      );
    })
  );
}

export interface McpStatus {
  socket: string | null;
  error: string | null;
  /** Directories where the kimi config could not be planted because the user
   * keeps their own there. Reported rather than logged: those panes are the
   * ONLY ones that silently lack what every other pane got, and the fix
   * (move or remove that file) is the user's to make. Keyed by directory —
   * the same pane re-arming must not stack duplicates. */
  refused: { root: string; reason: string }[];
}

/** A failure's detail, guaranteed to READ as a problem: an Error carrying
 * an empty message would otherwise render as a dangling "problem: ". */
function problem(detail: string | null): string {
  const text = detail?.trim();
  return text ? text : "the transport reported no detail";
}

/** The status after one settled transition (see [`McpStatus`] for why a
 * failure keeps the previous socket claim). */
function statusAfter(previous: McpStatus, transition: McpTransition): McpStatus {
  const refused = previous.refused;
  if (!transition.ok) {
    return { socket: previous.socket, error: problem(transition.detail), refused };
  }
  if (!transition.desired) {
    // Off takes the refusals with it: nothing is planted any more, so a
    // directory that once refused is no longer withholding anything.
    return { socket: null, error: null, refused: [] };
  }
  return transition.detail !== null
    ? { socket: transition.detail, error: null, refused }
    : // Defensive: mcp_enable's contract is a path string; a confirmation
      // without one must degrade LOUDLY, not into a blank served-less On.
      {
        socket: null,
        error: "the backend confirmed On without a socket path",
        refused,
      };
}

export interface McpService {
  status(): McpStatus;
  subscribe(listener: () => void): () => void;
  /** The MCP servers a spawning pane should be given — empty while the
   * transport is not confirmed up. The injection half of the feature; see
   * [`createMcpInjection`]. */
  defs: McpInjection["defs"];
  dispose(): void;
}

/** Everything the service touches beyond its own parts. `panesIn` is
 * production wiring; the rest are test seams with production defaults. */
export interface McpServiceDeps {
  /** How many live panes run in a directory — see [`McpInjectionDeps`]. */
  panesIn: McpInjectionDeps["panesIn"];
  /** Plant / retract kimi's config, ordered against worktree teardown. */
  arm: McpInjectionDeps["arm"];
  disarm: McpInjectionDeps["disarm"];
  registry?: CommandRegistry;
  transport?: McpTransportPort;
  pumpPorts?: McpPumpPorts;
  identitySource?: () => Promise<{ name: string; version: string }>;
  connection?: McpInjectionDeps["connection"];
  /** Resolve a connection's secret to the pane that announced it. Injected:
   * which pane holds which secret is the spawn layer's knowledge, and the
   * deck's — neither belongs to the transport. */
  identify?: (client: string) => McpPaneIdentity | null;
}

/** How a pane reads in the journal at the moment it acted. */
export interface McpPaneIdentity {
  id: string;
  workspaceId: string;
  label: string;
}

/**
 * The MCP feature's one owner in the webview. Everything the feature IS —
 * the request pump, the registry projection, the settings-driven lifecycle
 * policy, the order they come up in, and the resulting status — lives
 * behind this front door; the composition root holds one handle, and the
 * settings UI reads `status()` instead of re-deriving "the server is on"
 * from the setting (the setting is a wish; the status is what the backend
 * confirmed — they differ exactly when the user most needs to know).
 *
 * Ordering is owned here, in both directions. Up: the policy — and with it
 * the first possible enable — is constructed only after the pump's event
 * subscription has REGISTERED on the backend (`pump.ready`), so a socket
 * client's first request cannot land while nothing is listening; dispatch
 * order alone would not give that, both legs being independent async IPC.
 * Down: the final teardown rides the policy's own serialized chain, so a
 * disposed page can never lose the race against its in-flight enable and
 * leave the socket up with nobody answering.
 */
export function createMcpService(
  settings: McpSettingsPort,
  deps: McpServiceDeps,
): McpService {
  const registry = deps.registry ?? commands;
  const transport = deps.transport ?? { enable: mcpEnable, disable: mcpDisable };

  let current: McpStatus = { socket: null, error: null, refused: [] };
  const listeners = new Set<() => void>();
  const publish = (next: McpStatus) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };

  // The identity is cosmetic (initialize's serverInfo) and must never gate
  // a request: the fetch fills it in when it lands; until then — or if it
  // never does — the fallback serves.
  /** Directories the LAST pass planted in — a refusal there is stale and
   * must clear (the user moved their file away). */
  const armedRoots = new Set<string>();
  let identity: McpServerIdentity = { name: "KeepDeck", version: "unknown" };
  void (deps.identitySource ?? fetchAppInfo)()
    .then((info) => {
      identity = { name: info.name, version: info.version };
    })
    .catch(() => {});

  /** Who a connection is, as the journal will record it. The ONE place that
   * turns a token into an identity: a secret that no longer resolves — a
   * hand-wired server, or a lingering child of a pane that is gone — reads as
   * an anonymous client, which is the behaviour that existed before panes
   * could be named at all. */
  function sourceFor(client: string | null): CommandSource {
    const pane = client ? (deps.identify?.(client) ?? null) : null;
    return pane
      ? { kind: "external", client: MCP_TRANSPORT, pane }
      : { kind: "external", client: MCP_TRANSPORT };
  }

  const port: McpCommandPort = {
    list: () => registry.list(),
    execute: (id, args, client) => registry.execute(id, args, sourceFor(client)),
  };
  // Reads the CONFIRMED status through a closure rather than a snapshot:
  // `current` moves with every settled transition.
  const injection = createMcpInjection({
    socket: () => current.socket,
    panesIn: deps.panesIn,
    arm: deps.arm,
    disarm: deps.disarm,
    onRefused: (refusals) => {
      // Replace by directory, keep the rest: an arming pass speaks only for
      // the cwds it tried, and dropping the others would make a refusal
      // vanish the moment another pane spawned somewhere else.
      const byRoot = new Map(current.refused.map((r) => [r.root, r]));
      for (const refusal of refusals) byRoot.set(refusal.root, refusal);
      for (const root of armedRoots) byRoot.delete(root);
      armedRoots.clear();
      const refused = [...byRoot.values()];
      // Compared by CONTENT: a refusal whose reason changed — the user
      // deleted their file but the directory is read-only now — keeps the
      // list the same length while saying something else entirely.
      if (!sameRefusals(refused, current.refused)) {
        publish({ ...current, refused });
      }
    },
    onArmed: (roots) => {
      for (const root of roots) armedRoots.add(root);
    },
    ...(deps.connection ? { connection: deps.connection } : {}),
  });
  const pump = createMcpRequestPump(
    (line, client) => handleMcpLine(port, () => identity, line, client),
    deps.pumpPorts,
  );
  let policy: McpServerPolicy | null = null;
  let disposed = false;
  void pump.ready.then((registered) => {
    if (disposed) return;
    if (!registered) {
      // A socket in front of a pump that can never hear it is worse than
      // no socket: every client request would park until the bridge times
      // it out, while the UI advertised a working server. Stay down, and
      // say why.
      publish({
        socket: null,
        error: "the deck cannot receive MCP requests — the event channel failed",
        refused: [],
      });
      return;
    }
    policy = createMcpServerPolicy(settings, transport, (transition) => {
      publish(statusAfter(current, transition));
      // A confirmed Off takes the planted configs with it: the socket they
      // name is gone, and a kimi pane reading one would spawn a shim that
      // cannot connect. Fire-and-forget — the backend's armed manifest still
      // records anything this fails to remove, and the boot sweep reads it.
      if (transition.ok && !transition.desired) {
        void injection.retract();
      }
    });
  });

  return {
    status: () => current,
    defs: injection.defs,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (policy) {
        // The teardown rides the policy's chain — a webview on its way out
        // (reload) must not leave the socket serving with nobody to answer,
        // and must not lose the race against its own in-flight enable.
        policy.dispose({ disable: true });
      } else {
        // No policy means nothing was ever enabled BY THIS PAGE — but a
        // predecessor may have left the socket up; best-effort, guarded
        // against a synchronously-throwing injected transport.
        void Promise.resolve()
          .then(() => transport.disable())
          .catch(() => {});
      }
      pump.dispose();
      // Listeners are deliberately NOT cleared: a mounted subscriber's
      // teardown is its own unsubscribe, and evicting it here would leave
      // it permanently deaf if the page outlives the service (HMR, tests).
    },
  };
}
