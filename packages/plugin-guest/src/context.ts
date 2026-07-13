import type {
  AgentHooks,
  CommandInfo,
  CommandResult,
  Disposable,
  FileOpenRequest,
  FsEntry,
  FsFile,
  GitBranches,
  GitChangedFile,
  GitHistory,
  GitStatus,
  PluginContext,
  PluginManifest,
  PluginSessionEvent,
} from "@keepdeck/plugin-api";
import { describeError } from "./errors";
import type { GuestRpc } from "./rpc";
import type { WireHookCall, WireOpenCall, WireSessionEvent } from "./protocol";

/** A guest context wired to a bridge, plus the sink the connection pumps
 * host-initiated `event` pushes into. */
export interface GuestContextBundle {
  ctx: PluginContext;
  /** Route one host push to whichever local subscribers registered for it. */
  dispatchEvent(channel: string, payload: unknown): void;
  /** Resolves when every registration fired so far has been ACCEPTED by the
   * host; rejects with the first refusal (an undeclared contribution, a gate
   * violation). `activate` awaits this before reporting success — a plugin
   * must not show "active" with a contribution silently missing. */
  registrationsSettled(): Promise<void>;
}

/**
 * Build the `PluginContext` an external plugin's `activate` runs against — the
 * mirror image of the host's `buildPluginContext`, but every member is a proxy
 * that speaks the RPC bridge instead of touching a live backend.
 *
 * Three shapes need local state on this side, all of it torn down by the
 * `Disposable` the plugin holds:
 *
 * - **Subscriptions** (deck events, settings changes) fan OUT locally: many
 *   plugin callbacks share ONE host subscription per channel, attached on the
 *   first listener and detached on the last, so the wire carries the minimum.
 * - **Sessions** keep the caller's `onEvent` here, keyed by the id the host
 *   returns, and re-hydrate each `output`'s `number[]` back into a `Uint8Array`
 *   before the plugin sees it — the typed array never crossed the wire.
 * - **Actions** keep the `run` callback here (a function can't cross the wire);
 *   the host fires an `action:<kind>:<id>` push and we fan it back to `run`.
 *
 * Every registration is minted a `regId` the host retains its `Disposable`
 * under; disposing on this side both cleans up locally and asks the host to
 * retire that `regId`.
 */
export function buildGuestContext(
  rpc: GuestRpc,
  manifest: PluginManifest,
): GuestContextBundle {
  const noop = (): void => {};

  // ---- local fan-out registries, all keyed so dispatchEvent can find them ----
  // `channelListeners` holds the plain broadcast channels (deck events AND the
  // settings-change feed): each fans one host subscription out to many local
  // callbacks. Sessions and actions need per-id routing, so they get their own.
  const channelListeners = new Map<string, Set<(payload: unknown) => void>>();
  const sessionListeners = new Map<string, (event: PluginSessionEvent) => void>();
  // Session output can arrive before the `spawn` result installs the handle's
  // listener (the backend emits early; the host addresses it by the real id).
  // Hold such events per id and flush them the instant the listener registers,
  // so a program's opening output is never dropped in that window.
  const sessionBuffers = new Map<string, PluginSessionEvent[]>();
  const actionCallbacks = new Map<string, (target?: unknown) => void>();
  // Agent hooks stay HERE (functions can't cross the wire); the host pushes
  // `hook:<id>` per invocation and we answer with `agents.hookResult`.
  const agentHooks = new Map<string, AgentHooks>();
  // File-open handlers likewise: identity crosses as data, the open()
  // callback stays here; the host pushes `open:<id>` and we answer with
  // `openers.openResult`.
  const openHandlers = new Map<
    string,
    (request: FileOpenRequest) => Promise<boolean>
  >();
  // One `fswatch:<id>` change callback per open directory watch.
  const watchCallbacks = new Map<string, () => void>();
  let nextRegId = 1;

  /** Attach a broadcast-channel listener with a ref-counted host subscription:
   * subscribe on the wire only when a channel gains its FIRST local listener,
   * unsubscribe only when it loses its LAST. */
  function subscribeChannel(
    channel: string,
    cb: (payload: unknown) => void,
    subscribe: () => void,
    unsubscribe: () => void,
  ): Disposable {
    let set = channelListeners.get(channel);
    if (!set) {
      set = new Set();
      channelListeners.set(channel, set);
      subscribe();
    }
    set.add(cb);
    let live = true;
    return {
      dispose() {
        if (!live) return;
        live = false;
        const current = channelListeners.get(channel);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) {
          channelListeners.delete(channel);
          unsubscribe();
        }
      },
    };
  }

  // Registration outcomes, awaited by `registrationsSettled` — a refused
  // contribution FAILS activation instead of vanishing silently.
  const registrations: Promise<unknown>[] = [];

  /** Register a contribution over the wire and hand back a `Disposable` that
   * both runs local cleanup and asks the host to retire the registration. */
  function registerRemote(
    path: string,
    entry: unknown,
    localCleanup: () => void,
  ): Disposable {
    const regId = nextRegId++;
    registrations.push(rpc.call(path, [regId, entry]));
    let live = true;
    return {
      dispose() {
        if (!live) return;
        live = false;
        localCleanup();
        void rpc.call("registrations.dispose", [regId]).catch(noop);
      },
    };
  }

  /** Open one host-side watch (fs directory or git repo — same wire shape:
   * guest-minted id, `fswatch:<id>` pushes back). The callback stays here;
   * dispose both unfiles it and asks the host to stop watching. */
  function remoteWatch(
    service: "fs" | "git",
    path: string,
    onChange: () => void,
  ): Disposable {
    const id = nextRegId++;
    const channel = `fswatch:${id}`;
    watchCallbacks.set(channel, onChange);
    void rpc.call(`services.${service}.watch`, [id, path]).catch(noop);
    let live = true;
    return {
      dispose() {
        if (!live) return;
        live = false;
        watchCallbacks.delete(channel);
        void rpc.call(`services.${service}.unwatch`, [id]).catch(noop);
      },
    };
  }

  const ctx: PluginContext = {
    manifest,

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
          action.run(target as { wsId: string; paneId: string }),
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

    settings: {
      registerSection: (section) => {
        // A React component cannot cross the sandbox boundary — the custom
        // field kind is built-in-tier only, and failing here names the rule
        // instead of serializing a function into junk.
        if (section.fields.some((field) => field.kind === "custom")) {
          throw new Error(
            'settings fields of kind "custom" are not available to external plugins — declare only data-driven fields',
          );
        }
        return registerRemote("settings.registerSection", section, noop);
      },
      read: () =>
        rpc.call("settings.read", []) as Promise<Record<string, unknown>>,
      // The settings-change feed is just another broadcast channel — ref-counted
      // and fanned out exactly like a deck event, over its own subscribe path.
      onChange: (cb) =>
        subscribeChannel(
          "settingsChanged",
          (payload) => cb(payload as Record<string, unknown>),
          () => void rpc.call("settings.onChange", []).catch(noop),
          () => void rpc.call("settings.offChange", []).catch(noop),
        ),
    },

    commands: {
      // Registering needs a host→realm call cycle for `run` (the agents-hook
      // pattern); it lands with its first external consumer — the built-in
      // tier already has the full surface. Executing and listing are plain
      // calls and work today.
      register: () => {
        throw new Error(
          "commands.register is not yet available to external plugins — the built-in tier has it; executing commands works on both",
        );
      },
      execute: (id, args) =>
        rpc.call("commands.execute", [id, args]) as Promise<CommandResult>,
      list: () => rpc.call("commands.list", []) as Promise<CommandInfo[]>,
    },
    agents: {
      // Identity crosses as data; the hooks stay in this realm and the host
      // invokes them per spawn through `hook:<id>` pushes.
      register: (agent) => {
        agentHooks.set(agent.id, agent.hooks);
        return registerRemote(
          "agents.register",
          {
            id: agent.id,
            label: agent.label,
            detect: agent.detect,
            hookNames: Object.keys(agent.hooks),
          },
          () => agentHooks.delete(agent.id),
        );
      },
    },

    resources: {
      path: (relative) =>
        rpc.call("resources.path", [relative]) as Promise<string | null>,
    },
    storage: {
      workspace: (wsId) => ({
        get: <T>(key: string): Promise<T | undefined> =>
          rpc.call("storage.workspace.get", [wsId, key]) as Promise<T | undefined>,
        set: (key, value) =>
          rpc.call("storage.workspace.set", [wsId, key, value]).then(noop),
        delete: (key) =>
          rpc.call("storage.workspace.delete", [wsId, key]).then(noop),
      }),
      global: {
        get: <T>(key: string): Promise<T | undefined> =>
          rpc.call("storage.global.get", [key]) as Promise<T | undefined>,
        set: (key, value) => rpc.call("storage.global.set", [key, value]).then(noop),
        delete: (key) => rpc.call("storage.global.delete", [key]).then(noop),
      },
    },

    events: {
      onWorkspaceClosed: (cb) =>
        subscribeChannel(
          "workspaceClosed",
          (payload) => cb(payload as { wsId: string }),
          () => void rpc.call("events.subscribe", ["workspaceClosed"]).catch(noop),
          () => void rpc.call("events.unsubscribe", ["workspaceClosed"]).catch(noop),
        ),
      onPaneSelected: (cb) =>
        subscribeChannel(
          "paneSelected",
          (payload) => cb(payload as { wsId: string; paneId: string | null }),
          () => void rpc.call("events.subscribe", ["paneSelected"]).catch(noop),
          () => void rpc.call("events.unsubscribe", ["paneSelected"]).catch(noop),
        ),
      onDeckChanged: (cb) =>
        subscribeChannel(
          "deckChanged",
          () => cb(),
          () => void rpc.call("events.subscribe", ["deckChanged"]).catch(noop),
          () => void rpc.call("events.unsubscribe", ["deckChanged"]).catch(noop),
        ),
    },

    services: {
      sessions: {
        spawn: (opts, onEvent) =>
          (rpc.call("services.sessions.spawn", [opts]) as Promise<{ id: string }>).then(
            ({ id }) => {
              sessionListeners.set(id, onEvent);
              // Flush anything that arrived before this listener existed.
              const buffered = sessionBuffers.get(id);
              if (buffered) {
                sessionBuffers.delete(id);
                for (const event of buffered) onEvent(event);
              }
              return {
                id,
                write: (data) =>
                  rpc.call("services.sessions.write", [id, data]).then(noop),
                resize: (cols, rows) =>
                  rpc.call("services.sessions.resize", [id, cols, rows]).then(noop),
                close: () => {
                  sessionListeners.delete(id);
                  return rpc.call("services.sessions.close", [id]).then(noop);
                },
              };
            },
          ),
      },
      ports: {
        allocate: (key) =>
          rpc.call("services.ports.allocate", [key]) as Promise<number>,
      },
      opener: {
        openUrl: (url) => rpc.call("services.opener.openUrl", [url]).then(noop),
        openPath: (path) => rpc.call("services.opener.openPath", [path]).then(noop),
        openPathWith: (path, application) =>
          rpc.call("services.opener.openPathWith", [path, application]).then(noop),
      },
      fs: {
        readDir: (path) =>
          rpc.call("services.fs.readDir", [path]) as Promise<FsEntry[]>,
        readFile: (path, opts) =>
          rpc.call("services.fs.readFile", [path, opts]) as Promise<FsFile>,
        watch: (path, onChange) => remoteWatch("fs", path, onChange),
      },
      git: {
        status: (repo) =>
          rpc.call("services.git.status", [repo]) as Promise<GitStatus>,
        diffFile: (repo, file, opts) =>
          rpc.call("services.git.diffFile", [repo, file, opts]) as Promise<string>,
        history: (repo, opts) =>
          rpc.call("services.git.history", [repo, opts]) as Promise<GitHistory>,
        branches: (repo) =>
          rpc.call("services.git.branches", [repo]) as Promise<GitBranches>,
        changedFiles: (repo, from, to) =>
          rpc.call("services.git.changedFiles", [repo, from, to]) as Promise<
            GitChangedFile[]
          >,
        watch: (repo, onChange) => remoteWatch("git", repo, onChange),
      },
      voice: {
        // Capture and downloads need push channels across the realm (level
        // meter, progress) — external voice waits for its first consumer,
        // like commands.register. Fail loudly, not silently.
        models: () => Promise.reject(unavailableVoice()),
        downloadModel: () => Promise.reject(unavailableVoice()),
        deleteModel: () => Promise.reject(unavailableVoice()),
        startCapture: () => Promise.reject(unavailableVoice()),
        stopCapture: () => Promise.reject(unavailableVoice()),
        cancelCapture: () => Promise.reject(unavailableVoice()),
      },
    },

    host: {
      settings: () =>
        rpc.call("host.settings", []) as ReturnType<PluginContext["host"]["settings"]>,
    },

    log: {
      info: (message) => void rpc.call("log.info", [message]).catch(noop),
      warn: (message) => void rpc.call("log.warn", [message]).catch(noop),
      error: (message) => void rpc.call("log.error", [message]).catch(noop),
    },
  };

  function unavailableVoice(): Error {
    return new Error(
      "the voice service is not yet available to external plugins",
    );
  }

  /** Run one host-requested agent hook and post the mutated output back. */
  async function runHook(callId: number, payload: unknown): Promise<void> {
    const { agentId, hook, input, output } = payload as WireHookCall;
    try {
      const fn = agentHooks.get(agentId)?.[hook as keyof AgentHooks];
      if (!fn) throw new Error(`no ${hook} hook for agent "${agentId}"`);
      await fn(input as never, output as never);
      void rpc.call("agents.hookResult", [callId, { ok: true, output }]).catch(noop);
    } catch (error) {
      void rpc
        .call("agents.hookResult", [
          callId,
          { ok: false, error: describeError(error) },
        ])
        .catch(noop);
    }
  }

  /** Run one host-requested file-open and post the boolean verdict back. */
  async function runOpen(callId: number, payload: unknown): Promise<void> {
    const { handlerId, request } = payload as WireOpenCall;
    try {
      const open = openHandlers.get(handlerId);
      if (!open) throw new Error(`no file-open handler "${handlerId}"`);
      const handled = await open(request);
      void rpc
        .call("openers.openResult", [callId, { ok: true, handled: handled === true }])
        .catch(noop);
    } catch (error) {
      void rpc
        .call("openers.openResult", [
          callId,
          { ok: false, error: describeError(error) },
        ])
        .catch(noop);
    }
  }

  function dispatchEvent(channel: string, payload: unknown): void {
    if (channel.startsWith("hook:")) {
      void runHook(Number(channel.slice("hook:".length)), payload);
      return;
    }
    if (channel.startsWith("open:")) {
      void runOpen(Number(channel.slice("open:".length)), payload);
      return;
    }
    if (channel.startsWith("session:")) {
      const id = channel.slice("session:".length);
      const event = rehydrateSessionEvent(payload);
      const onEvent = sessionListeners.get(id);
      if (onEvent) {
        onEvent(event);
      } else {
        // The handle isn't registered yet — buffer until spawn's result does.
        const buffer = sessionBuffers.get(id) ?? [];
        buffer.push(event);
        sessionBuffers.set(id, buffer);
      }
      return;
    }
    if (channel.startsWith("action:")) {
      const run = actionCallbacks.get(channel.slice("action:".length));
      if (run) run(payload);
      return;
    }
    if (channel.startsWith("fswatch:")) {
      watchCallbacks.get(channel)?.();
      return;
    }
    // Deck events and the settings-change feed alike land in `channelListeners`.
    const set = channelListeners.get(channel);
    if (set) for (const cb of [...set]) cb(payload);
  }

  return {
    ctx,
    dispatchEvent,
    registrationsSettled: () => Promise.all(registrations).then(noop),
  };
}

/** The key an action's `run` is filed under locally — the SAME suffix the host
 * puts after `action:` when it pushes the firing. */
function actionKey(kind: "topBar" | "pane", id: string): string {
  return `${kind}:${id}`;
}

/** Turn a wire session event back into a `PluginSessionEvent`, rebuilding the
 * `Uint8Array` the plugin's `onEvent` expects from the `number[]` on the wire. */
function rehydrateSessionEvent(payload: unknown): PluginSessionEvent {
  const wire = payload as WireSessionEvent;
  return wire.type === "output"
    ? { type: "output", bytes: new Uint8Array(wire.bytes) }
    : { type: "exit", code: wire.code };
}
