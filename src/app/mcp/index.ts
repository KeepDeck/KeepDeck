import type { CommandRegistry, CommandSource } from "../../domain/commands";
import {
  handleMcpLine,
  type McpCommandPort,
  type McpServerIdentity,
} from "../../domain/mcp";
import { fetchAppInfo } from "../../ipc/app";
import { describeError } from "../../ipc/log";
import {
  mcpConnectionCommand,
  mcpDisable,
  mcpEnable,
  type McpConnection,
} from "../../ipc/mcp";
import { commands } from "../commandRegistry";
import type { McpPaneIdentity } from "./paneIdentity";
import {
  createMcpInjection,
  type McpInjection,
  type McpInjectionDeps,
} from "./injection";

/** What the spawn path asks for and hands to a hook — re-exported here so a
 * consumer depends on the FEATURE, not on the module inside it. */
export type {
  McpAccess,
  McpAccessAsk,
  McpInjectionTarget,
} from "./injection";
import { createMcpRequestPump, type McpPumpPorts } from "./pump";
import {
  createMcpServerPolicy,
  type McpServerPolicy,
  type McpSettingsPort,
  type McpTransition,
  type McpTransportPort,
} from "./policy";

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

/** What the app knows about the transport as of the LAST SETTLED transition —
 * confirmed by the backend, not wished by the setting, and not re-probed in
 * between. `socket` is the served path the backend last confirmed; `error` is
 * why the last transition failed — and after a failure the socket claim is
 * KEPT, because nothing confirmed a change (a failed disable most likely
 * leaves the socket serving). */
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
    // The socket CLAIM is kept — nothing confirmed the socket went away — but
    // the line naming it is not: a failed enable following a failed disable
    // would otherwise hand the user a copy-pasteable command minted for a
    // socket two transitions ago. The lookup that follows every transition
    // re-derives it against whatever is actually claimed now.
    return {
      ...previous,
      error: problem(transition.detail),
      connect: null,
      connectError: null,
      refused,
    };
  }
  // Every settled change to the socket invalidates the line that names it —
  // the lookup that follows is what fills it back in.
  const blank = { connect: null, connectError: null };
  if (!transition.desired) {
    // Off takes the refusals with it: nothing is planted any more, so a
    // directory that once refused is no longer withholding anything.
    return { socket: null, error: null, refused: [], ...blank };
  }
  return transition.detail !== null
    ? { socket: transition.detail, error: null, refused, ...blank }
    : // Defensive: mcp_enable's contract is a path string; a confirmation
      // without one must degrade LOUDLY, not into a blank served-less On.
      {
        socket: null,
        error: "the backend confirmed On without a socket path",
        refused,
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
  /**
   * Bring the DERIVED parts of the status up to date.
   *
   * Two things go stale on their own and nothing else notices: a refusal
   * whose pane has since closed (the list is keyed by directory, and only a
   * later successful arming of that same directory cleared it), and a connect
   * lookup that never landed (it fires once per settled transition, so a
   * request that got lost stayed lost until the user toggled the transport).
   *
   * Idempotent and cheap. A settings surface calls it when it mounts — which
   * is the moment both staleness becomes visible — WITHOUT reaching for IPC
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
  /** Plant / retract kimi's config through the owner of the directories it
   * lands in — see [`McpPlanting`]. */
  plant: McpInjectionDeps["plant"];
  retract: McpInjectionDeps["retract"];
  registry?: CommandRegistry;
  transport?: McpTransportPort;
  pumpPorts?: McpPumpPorts;
  identitySource?: () => Promise<{ name: string; version: string }>;
  connection?: McpInjectionDeps["connection"];
  /** Resolve a connection's secret to the pane that announced it. Injected:
   * which pane holds which secret is the spawn layer's knowledge, and the
   * deck's — neither belongs to the transport. See [`createPaneIdentity`]. */
  identify?: (client: string) => McpPaneIdentity | null;
}

export type { McpPaneIdentity } from "./paneIdentity";

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
  const connection = deps.connection ?? mcpConnectionCommand;

  let current: McpStatus = {
    socket: null,
    error: null,
    connect: null,
    connectError: null,
    refused: [],
  };
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
    plant: deps.plant,
    retract: deps.retract,
    onRefused: (refusals) => {
      // Replace by directory, keep the rest: an arming pass speaks only for
      // the cwds it tried, and dropping the others would make a refusal
      // vanish the moment another pane spawned somewhere else.
      const byRoot = new Map(current.refused.map((r) => [r.root, r]));
      // Armed first, refused second: a pass that both armed and refused the
      // same directory is telling us about the refusal, and deleting after
      // the merge would swallow it.
      for (const root of armedRoots) byRoot.delete(root);
      armedRoots.clear();
      for (const refusal of refusals) {
        byRoot.set(refusal.root, refusal);
        // Noted AT RECORD TIME, because that is the only moment that tells
        // the two cases apart: a fresh spawn's pane is already in the deck,
        // a resume's or a fork's is not. Without it every refusal would look
        // like the second and none would ever be prunable.
        if (deps.panesIn(refusal.root) > 0) landed.add(refusal.root);
      }
      // Everything this pass did not speak for is judged by the same rule the
      // settings surface applies — a refusal survives until its pane has been
      // SEEN and then gone. THIS pass's roots skip even that: they were just
      // refused, and a resume or fork plants before its pane lands.
      const fresh = new Set(refusals.map((refusal) => refusal.root));
      const refused = [...byRoot.values()].filter(
        (refusal) => fresh.has(refusal.root) || worthShowing(refusal.root),
      );
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
    connection,
  });
  const pump = createMcpRequestPump(
    (line, client) => handleMcpLine(port, () => identity, line, client),
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
          publish({ ...current, connect: null, connectError: describeError(e) });
        }
      });
  }

  /** Directories the deck has counted a pane in since we refused there. Until
   * it has, "no pane runs here" cannot mean the pane went away — it means the
   * pane has not LANDED. A resume or a fork plants before it does, and those
   * refusals are the ones that matter most: the pane silently has no servers
   * and this list is the only place that says so. */
  const landed = new Set<string>();

  /** Refusals worth still showing. The list is keyed by directory and cleared
   * only by a later successful arming of that same directory, so without this
   * it names folders whose pane closed hours ago and grows for the life of the
   * session — but a refusal is dropped only once its pane has been seen, and
   * then gone. */
  function worthShowing(root: string): boolean {
    if (deps.panesIn(root) > 0) {
      landed.add(root);
      return true;
    }
    return !landed.has(root);
  }

  function stillRunning(
    refusals: readonly { root: string; reason: string }[],
  ): { root: string; reason: string }[] {
    return refusals.filter((refusal) => worthShowing(refusal.root));
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
        refused: [],
      });
      return;
    }
    policy = createMcpServerPolicy(settings, transport, (transition) => {
      // A transition already in flight when the page went away still settles,
      // and this callback rides the policy's own chain — so without this it
      // publishes to listeners a disposed page never dropped, issues a fresh
      // lookup during teardown, and can fire a retract after it.
      if (disposed) return;
      publish(statusAfter(current, transition));
      refreshConnect();
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
    access: injection.access,
    refresh() {
      if (disposed) return;
      const refused = stillRunning(current.refused);
      if (!sameRefusals(refused, current.refused)) {
        publish({ ...current, refused });
      }
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
