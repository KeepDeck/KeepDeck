import type { CommandRegistry, CommandSource } from "../../domain/commands";
import {
  handleMcpLine,
  type McpCaller,
  type McpCommandPort,
  type McpServerIdentity,
} from "../../domain/mcp";
import { readAppInfo } from "../appInfo";

import {
  mcpConnectionCommand,
  mcpDisable,
  mcpEnable,
  type McpConnection,
} from "../../ipc/mcp";
import { commands } from "../commandRegistry";
import type { McpPaneIdentity } from "./paneIdentity";
import {
  keepdeckServer,
  type BundledMcpContributor,
  type BundledMcpDescription,
  type KeepdeckServerDeps,
} from "./bundled";
import {
  createMcpInjection,
  type McpInjection,
  type McpInjectionDeps,
  type McpServerSource,
} from "./injection";

import { createMcpRequestPump, type McpPumpPorts } from "./pump";
import {
  createMcpServerPolicy,
  type McpServerPolicy,
  type McpTransition,
  type McpTransportPort,
} from "./policy";
import { errorMessage } from "@keepdeck/plugin-api";

/** The transport every external call is journaled under. */
const MCP_TRANSPORT = "mcp";

/** What the app knows about the transport as of the LAST SETTLED enable —
 * confirmed by the backend, not assumed, and not re-probed in between.
 * `socket` is the served path the backend confirmed, claimed once for the
 * page's life (the socket goes down only with the page); `error` is why the
 * enable failed, until a retry succeeds. */
export interface McpStatus {
  socket: string | null;
  error: string | null;
  /** How a client KeepDeck does NOT start reaches the socket — a desktop app,
   * an editor, an agent run outside the deck. Fetched from the backend, never
   * computed: only it knows where this install's binary lives, and a second
   * derivation would drift the day the shim's flags change. Null while the
   * transport is down and until the lookup lands.
   *
   * Kept here rather than in whatever settings surface happens to show it: it
   * is a fact about the running transport, true whether or not that surface is
   * open, and a component holding it re-fetches on every mount. */
  connect: McpConnection | null;
  /** Why that lookup failed, when it did — the server IS serving, so this is
   * a message and never a silently missing row. */
  connectError: string | null;
}

/** A failure's detail, guaranteed to READ as a problem: an Error carrying
 * an empty message would otherwise render as a dangling "problem: ". */
function problem(detail: string | null): string {
  const text = detail?.trim();
  return text ? text : "the transport reported no detail";
}

/** The status after one settled enable. */
function statusAfter(previous: McpStatus, transition: McpTransition): McpStatus {
  // Every settled enable invalidates the line naming the socket — the lookup
  // that follows is what fills it back in, against what is actually claimed.
  const blank = { connect: null, connectError: null };
  if (!transition.ok) {
    return { ...previous, error: problem(transition.detail), ...blank };
  }
  return transition.detail !== null
    ? { socket: transition.detail, error: null, ...blank }
    : // Defensive: mcp_enable's contract is a path string; a confirmation
      // without one must degrade LOUDLY, not into a blank served-less On.
      {
        socket: null,
        error: "the backend confirmed On without a socket path",
        ...blank,
      };
}

export interface McpService {
  status(): McpStatus;
  subscribe(listener: () => void): () => void;
  /** One pane's access to the MCP servers — empty while the transport is not
   * confirmed up. The injection half of the feature; see
   * [`createMcpInjection`]. */
  access: McpInjection["access"];
  /** The bundled tier as a surface lists it, read NOW: the set is fixed for
   * the service's life, what each member shows moves with the status. */
  bundled(): BundledMcpDescription[];
  /**
   * Bring the status up to date with what a user is about to look at.
   *
   * Two things go stale on their own and nothing else notices: a refused
   * enable (another instance held the socket — a retry is due, and there is
   * no setting event to carry it), and a connect lookup that never landed
   * (it fires once per settled enable, so a request that got lost stayed
   * lost).
   *
   * Idempotent and cheap. A settings surface calls it when it mounts — which
   * is the moment both become visible — WITHOUT reaching for IPC
   * itself; that is the whole point of it living here.
   */
  refresh(): void;
  dispose(): void;
}

/** Everything the service touches beyond its own parts. `panesIn` is
 * production wiring; the rest are test seams with production defaults. */
export interface McpServiceDeps {
  /** How many live panes run in a directory — see [`McpInjectionDeps`]. */
  panesIn: McpInjectionDeps["panesIn"];
  /** Whether an agent takes its servers through a file in its cwd — see
   * [`McpInjectionDeps`]. */
  deliversByCwd: McpInjectionDeps["deliversByCwd"];
  /** The user's library of servers, resolved per workspace — see
   * [`McpServerSource`]. Required even when empty, so "no library" is a
   * statement the composition root makes, never a default it fell into. */
  library: McpServerSource;
  registry?: CommandRegistry;
  transport?: McpTransportPort;
  pumpPorts?: McpPumpPorts;
  identitySource?: () => Promise<{ name: string; version: string }>;
  /** How a client reaches the socket — the deck's own bundled server and the
   * settings page's connect row both ask it. */
  connection?: KeepdeckServerDeps["connection"];
  /** Resolve a connection to the pane that announced it. Injected: which
   * pane holds which secret is the spawn layer's knowledge, and the deck's —
   * neither belongs to the transport. See [`createPaneIdentity`]. */
  identify?: (caller: McpCaller) => McpPaneIdentity | null;
}

/**
 * The MCP feature's one owner in the webview. Everything the feature IS —
 * the request pump, the registry projection, the lifecycle policy, the
 * order they come up in, and the resulting status — lives behind this front
 * door; the composition root holds one handle, and the settings UI reads
 * `status()`: the transport has no setting, so what the backend confirmed
 * is the only account of it there is.
 *
 * Ordering is owned here, in both directions. Up: the policy — and with it
 * the enable — is constructed only after the pump's event subscription has
 * REGISTERED on the backend (`pump.ready`), so a socket client's first
 * request cannot land while nothing is listening; dispatch order alone
 * would not give that, both legs being independent async IPC. Down: the
 * final teardown rides the policy's own serialized chain, so a disposed page
 * can never lose the race against its in-flight enable and leave the socket
 * up with nobody answering.
 */
export function createMcpService(deps: McpServiceDeps): McpService {
  const registry = deps.registry ?? commands;
  const transport = deps.transport ?? { enable: mcpEnable, disable: mcpDisable };
  const connection = deps.connection ?? mcpConnectionCommand;

  let current: McpStatus = {
    socket: null,
    error: null,
    connect: null,
    connectError: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: McpStatus) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };

  // The identity is cosmetic (initialize's serverInfo) and must never gate
  // a request: the fetch fills it in when it lands; until then — or if it
  // never does — the fallback serves.
  let identity: McpServerIdentity = { name: "KeepDeck", version: "unknown" };
  void (deps.identitySource ?? readAppInfo)()
    .then((info) => {
      identity = { name: info.name, version: info.version };
    })
    .catch(() => {});

  /** Who a connection is, as the journal will record it. The ONE place that
   * turns a token into an identity: a secret that no longer resolves — a
   * hand-wired server, or a lingering child of a pane that is gone — reads as
   * an anonymous client, which is the behaviour that existed before panes
   * could be named at all. */
  function sourceFor(caller: McpCaller): CommandSource {
    const pane = deps.identify?.(caller) ?? null;
    return pane
      ? { kind: "external", client: MCP_TRANSPORT, pane }
      : { kind: "external", client: MCP_TRANSPORT };
  }

  const port: McpCommandPort = {
    list: () => registry.list(),
    execute: (id, args, caller) => registry.execute(id, args, sourceFor(caller)),
  };
  // The bundled tier: the deck's own server, reading the CONFIRMED status
  // through a closure rather than a snapshot — `current` moves with every
  // settled transition. The user's library rides beside it, ungated.
  const contributors: BundledMcpContributor[] = [
    keepdeckServer({
      socket: () => current.socket,
      connect: () => current.connect,
      connection,
    }),
  ];
  const injection = createMcpInjection({
    contributors,
    library: deps.library,
    panesIn: deps.panesIn,
    deliversByCwd: deps.deliversByCwd,
  });
  const pump = createMcpRequestPump(
    (line, caller) => handleMcpLine(port, () => identity, line, caller),
    deps.pumpPorts,
  );
  let policy: McpServerPolicy | null = null;
  let disposed = false;

  /** Look up the hand-wiring invocation for the socket that is up NOW.
   *
   * Anonymous, unlike a pane's: there is no pane behind a client the user
   * wires by hand. Re-run on every settled transition rather than cached for
   * the session — the served path is part of the answer. The sequence guard
   * drops a late reply whose socket has since been replaced or torn down; a
   * failure is a message, never a missing row, because the server IS serving.
   */
  let connectSeq = 0;
  function refreshConnect(): void {
    const seq = ++connectSeq;
    if (current.socket === null) return;
    const settled = () => !disposed && seq === connectSeq && current.socket !== null;
    void connection()
      .then((invocation) => {
        if (settled()) publish({ ...current, connect: invocation, connectError: null });
      })
      .catch((e: unknown) => {
        if (settled()) {
          publish({ ...current, connect: null, connectError: errorMessage(e) });
        }
      });
  }

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
        connect: null,
        connectError: null,
      });
      return;
    }
    policy = createMcpServerPolicy(transport, (transition) => {
      // An enable already in flight when the page went away still settles,
      // and this callback rides the policy's own chain — so without this it
      // publishes to listeners a disposed page never dropped and issues a
      // fresh lookup during teardown.
      if (disposed) return;
      publish(statusAfter(current, transition));
      refreshConnect();
    });
  });

  return {
    status: () => current,
    access: injection.access,
    bundled: () =>
      contributors.map((contributor) => ({
        name: contributor.name,
        body: contributor.describe(),
      })),
    refresh() {
      if (disposed) return;
      // A refused enable is retried here and nowhere else: with no setting
      // to flip there is no event to ride, and a timer would hammer a socket
      // another instance legitimately holds. Someone opening a settings
      // surface bounds it instead.
      policy?.ensure();
      // Re-asked whenever the transport is up and we still have no line: the
      // first attempt errored, or never landed at all. A lookup genuinely in
      // flight is simply superseded — the sequence guard drops its reply — and
      // this runs on a user opening a settings surface, so it is bounded by
      // that rather than by a timer.
      if (current.socket !== null && current.connect === null) refreshConnect();
    },
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
