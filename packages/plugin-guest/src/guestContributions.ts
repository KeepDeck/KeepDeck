import type {
  AgentHooks,
  AgentHistory,
  AgentLiveSession,
  Disposable,
  FileOpenRequest,
  PluginContext,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import type { GuestRpc } from "./rpc";

/**
 * The three surfaces a plugin REGISTERS through, guest-side. They look
 * unrelated — a dock tab, a file-open handler, an agent — and they are one
 * thing: identity crosses the wire as plain data, the callbacks stay in this
 * realm, and the host invokes them later through a push keyed by the id it
 * was given.
 *
 * That split is the whole reason this file exists. A function cannot be
 * serialized, so every registration here is a pair: what the host may know
 * (data) and what only we can run (a callback filed in a local registry, and
 * unfiled again when the registration is disposed). Getting that pair wrong
 * in one place and right in the others is exactly the kind of drift a shared
 * home prevents.
 *
 * Two rules are load-bearing and easy to lose. A React component may NEVER
 * cross — it is refused here, synchronously, with a message that names the
 * fix, rather than failing later as unserializable. And a capability flag
 * tracks the OBJECT, never optimism: declaring a method the realm does not
 * implement gets the host asking for a call this side would have to refuse.
 */
export interface GuestContributionDeps {
  rpc: GuestRpc;
  noop: () => void;
  registerRemote: (
    path: string,
    entry: unknown,
    localCleanup: () => void,
  ) => Disposable;
  actionCallbacks: Map<string, (target?: unknown) => void>;
  openHandlers: Map<string, (request: FileOpenRequest) => Promise<boolean>>;
  agentHooks: Map<string, AgentHooks>;
  agentHistories: Map<string, AgentHistory>;
  agentLive: Map<string, { list(): Promise<AgentLiveSession[]> }>;
}

/** The key an action's `run` is filed under locally — the SAME suffix the host
 * puts after `action:` when it pushes the firing. */
export function actionKey(kind: "topBar" | "pane", id: string): string {
  return `${kind}:${id}`;
}

export function createGuestContributions({
  rpc,
  noop,
  registerRemote,
  actionCallbacks,
  openHandlers,
  agentHooks,
  agentHistories,
  agentLive,
}: GuestContributionDeps): Pick<PluginContext, "ui" | "openers" | "agents"> {
  return {
    ui: {
      registerDockTab: (tab) => {
        // An external dock tab is an iframe document path, never a component:
        // the host renders it in a sandboxed frame under the plugin's origin. A
        // React component cannot be serialized across the realm boundary, so we
        // reject it HERE, synchronously, with a message that names the fix.
        if ("Component" in tab) {
          throw new Error(
            "external dock tabs must use the `iframe` variant: a React Component cannot cross the plugin sandbox boundary",
          );
        }
        return registerRemote(
          "ui.registerDockTab",
          { id: tab.id, label: tab.label, iframe: tab.iframe },
          noop,
        );
      },
      registerTopBarAction: (action) => {
        const key = actionKey("topBar", action.id);
        actionCallbacks.set(key, () => action.run());
        return registerRemote(
          "ui.registerTopBarAction",
          { id: action.id, title: action.title },
          () => actionCallbacks.delete(key),
        );
      },
      registerPaneAction: (action) => {
        const key = actionKey("pane", action.id);
        actionCallbacks.set(key, (target) =>
          action.run(target as { workspace: WorkspaceRef; paneId: string }),
        );
        return registerRemote(
          "ui.registerPaneAction",
          { id: action.id, title: action.title },
          () => actionCallbacks.delete(key),
        );
      },
      registerOverlay: (overlay) => {
        // An external overlay is an iframe document, never a component: a
        // React Component cannot be serialized across the realm boundary.
        // Same rule (and message shape) as external dock tabs.
        if ("Component" in overlay) {
          throw new Error(
            "external overlays must use the `iframe` variant: a React Component cannot cross the plugin sandbox boundary",
          );
        }
        return registerRemote(
          "ui.registerOverlay",
          { id: overlay.id, iframe: overlay.iframe },
          noop,
        );
      },
      setOverlayVisible: (id, visible) =>
        void rpc.call("ui.setOverlayVisible", [id, visible]).catch(noop),
      // Fire-and-forget by contract (returns void) — a rejection has nowhere
      // to land, and the host treats an unregistered tab as a no-op anyway.
      revealDockTab: (id) => void rpc.call("ui.revealDockTab", [id]).catch(noop),
    },

    openers: {
      // Identity crosses as data; open() stays in this realm and the host
      // invokes it per click through `open:<id>` pushes — the agent-hook
      // pattern with a boolean answer.
      register: (handler) => {
        openHandlers.set(handler.id, handler.open);
        return registerRemote(
          "openers.register",
          { id: handler.id, label: handler.label },
          () => openHandlers.delete(handler.id),
        );
      },
    },

    agents: {
      // Identity crosses as data; the hooks stay in this realm and the host
      // invokes them per spawn through `hook:<id>` pushes.
      register: (agent) => {
        // Usage contributions cannot cross this boundary yet: the host
        // store calls `normalize` SYNCHRONOUSLY per report, and a
        // cross-realm proxy is necessarily async. Loud, not silent — and
        // it must be loud HERE, where the declaration actually exists (the
        // wire payload below never carried it, so a host-side check alone
        // was dead code — review finding).
        if (agent.usage !== undefined) {
          void rpc
            .call("log.warn", [
              `agent "${agent.id}": usage contributions are not carried across the external tier yet — ignored`,
            ])
            .catch(noop);
        }
        // Same boundary, same reason, same loudness for the status half:
        // the tracker calls `normalize` synchronously per report.
        if (agent.status !== undefined) {
          void rpc
            .call("log.warn", [
              `agent "${agent.id}": status contributions are not carried across the external tier yet — ignored`,
            ])
            .catch(noop);
        }
        agentHooks.set(agent.id, agent.hooks);
        if (agent.history) agentHistories.set(agent.id, agent.history);
        // The wire flag must track the OBJECT, not optimism: a false
        // declaration gets an old-guest host asking for a call this realm
        // would have to refuse.
        if (agent.liveSessions) agentLive.set(agent.id, agent.liveSessions);
        return registerRemote(
          "agents.register",
          {
            id: agent.id,
            label: agent.label,
            icon: agent.icon,
            detect: agent.detect,
            // Sparse like the host's read: only a true declaration crosses.
            ...(agent.supportsYolo === true && { supportsYolo: true }),
            hookNames: Object.keys(agent.hooks),
            ...(agent.history !== undefined && { hasHistory: true }),
            // Declared IFF the method really sits on the object — the
            // wire flag is the host's ONLY basis for exposing `listing`
            // in its proxy, and a standing proxy would get every old
            // guest asked for a method it throws on.
            ...(typeof agent.history?.listing === "function" && {
              hasListing: true,
            }),
            ...(typeof agent.history?.transcriptPage === "function" && {
              hasTranscriptPage: true,
            }),
            ...(agent.liveSessions !== undefined && { hasLiveSessions: true }),
          },
          () => {
            agentHooks.delete(agent.id);
            agentHistories.delete(agent.id);
            agentLive.delete(agent.id);
          },
        );
      },
    },
  };
}
