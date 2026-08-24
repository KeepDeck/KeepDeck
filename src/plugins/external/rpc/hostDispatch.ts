import type {
  AgentContribution,
  AgentHistory,
  AgentHooks,
  Disposable,
  DockTabContribution,
  PluginContext,
  SpeechCapture,
  SettingsSectionContribution,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import {
  actionChannel,
  DECK_EVENT_CHANNELS,
  historyChannel,
  hookChannel,
  livesessionsChannel,
  openChannel,
  type WireAgentHistoryCall,
  type WireAgentLiveSessionsCall,
  type WireHookCall,
  type WireOpenCall,
} from "./protocol";
import { createHostSessions } from "./hostSessions";
import { createHostSubscriptions } from "./hostSubscriptions";
import { createServiceHandlers } from "./hostServices";
import { createPendingCalls } from "./hostPendingCalls";
import {
  asRealmResult,
  requireHistoryResult,
  requireLiveResult,
  sanitizeAgentIcon,
  sanitizeHistoryContent,
  sanitizeHistoryFacts,
  sanitizeHistoryList,
  sanitizeHistoryListing,
  sanitizeHistoryTranscript,
  sanitizeHistoryTranscriptPage,
  sanitizeLiveSessions,
  sanitizePlanOutput,
} from "./hostSanitize";

/**
 * The routing core of the host bridge: a flat `path → handler` table over the
 * real `PluginContext`, plus the three stateful stores a realm accumulates
 * (subscriptions, sessions, registrations) and a `dispose` that empties them.
 *
 * Every handler is a thin adaptor from a positional `args` array onto one
 * context member — the table IS the contract surface, spelled out once. Three
 * shapes need more than a straight forward:
 *
 * - **Registrations** return a `Disposable` the guest can't hold across the
 *   wire, so we retain it under a guest-minted `regId` and let a later
 *   `registrations.dispose` retire it by that key.
 * - **Actions** carry a `run` callback the guest can't send; the host
 *   synthesises one that pushes an `action:<kind>:<id>` event, and the guest
 *   fans it back out.
 * - **Subscriptions / sessions** are delegated to their own stores.
 *
 * The side effect of a registration handler lands SYNCHRONOUSLY (before the
 * handler's returned promise settles), so a plugin's `activate` — which fires
 * its registrations and then signals `activated` — is guaranteed to have
 * populated the host's registries by the time `activated` is processed.
 */
export interface HostDispatch {
  /** Route one call; resolves with the member's return value, rejects if the
   * path is unknown or the member throws. Never mutates bridge lifetime. */
  call(path: string, args: unknown[]): Promise<unknown>;
  /** Tear down everything the realm accumulated — its subscriptions, its live
   * sessions, and its registered contributions. */
  dispose(): void;
}

export function createHostDispatch(
  ctx: PluginContext,
  push: (channel: string, payload: unknown) => void,
): HostDispatch {
  const subscriptions = createHostSubscriptions(ctx, push);
  const sessions = createHostSessions(ctx, push);

  // The four questions the host asks a realm and waits on. They differ only
  // in channel, deadline and what a good answer means — the waiting itself
  // lives in `hostPendingCalls`. Live-sessions rides its OWN channel rather
  // than history's: a different question of a different capability, and
  // keeping them apart is what keeps the history method union a promise every
  // guest can honor. The file-open deadline is tighter than the rest because
  // a user is watching a click.
  const hooks = createPendingCalls<unknown>(push, hookChannel, 10_000);
  const history = createPendingCalls<unknown>(push, historyChannel, 10_000);
  const live = createPendingCalls<unknown>(push, livesessionsChannel, 10_000);
  const opens = createPendingCalls<boolean>(push, openChannel, 5_000);

  /** Run ONE hook in the realm: push the call, await the correlated result,
   * copy the sanitized mutated output back into the caller's object — the
   * in-process mutate-in-place contract, preserved across the wire. */
  async function callHook(
    agentId: string,
    hook: string,
    input: unknown,
    output: SpawnPlanOutput,
  ): Promise<void> {
    const call: WireHookCall = { agentId, hook, input, output };
    // The realm's word shapes a SPAWN — nothing but plain strings may come
    // back, whatever a hostile realm actually sent.
    const mutated = sanitizePlanOutput(await hooks.call(call, hook));
    if (!mutated) throw new Error(`${hook} returned a malformed plan`);
    Object.assign(output, mutated);
  }

  function callHistory(
    agentId: string,
    method: WireAgentHistoryCall["method"],
    args: unknown[],
  ): Promise<unknown> {
    const call: WireAgentHistoryCall = { agentId, method, args };
    return history.call(call, `agent history ${method}`);
  }

  function callLiveSessions(agentId: string): Promise<unknown> {
    const call: WireAgentLiveSessionsCall = { agentId };
    return live.call(call, "agent live-sessions");
  }

  /** Ask the realm's handler about ONE file-open request. A timeout settles
   * the proxy as a rejection, which the host's file-open chain logs and
   * treats as a decline — the system opener takes the file. */
  function callOpen(handlerId: string, request: { path: string }): Promise<boolean> {
    const call: WireOpenCall = { handlerId, request };
    return opens.call(call, `file-open handler "${handlerId}"`);
  }

  // Flipped by dispose(). Guards the speech capture — an async acquisition
  // whose resource can land AFTER the sweep already ran. Sessions have the
  // same shape and carry their own guard (`hostSessions.spawn`); any NEW
  // handler that awaits a resource into existence and then stores it needs
  // one too.
  let disposed = false;
  // Registrations retained by the guest-minted id that will later dispose them.
  const registrations = new Map<number, Disposable>();
  // Directory watches, retained by the guest-minted id that will unwatch them.
  const watches = new Map<number, Disposable>();
  const activeDownloads = new Set<string>();
  const activeSpeechCaptures = new Map<number, SpeechCapture>();
  function retain(regId: number, disposable: Disposable): void {
    registrations.set(regId, disposable);
  }
  function disposeRegistration(regId: number): void {
    const disposable = registrations.get(regId);
    if (!disposable) return;
    registrations.delete(regId);
    disposable.dispose();
  }

  /** Guard a guest-supplied channel name before it reaches a subscription. */
  function asDeckChannel(channel: unknown): string {
    if (
      typeof channel !== "string" ||
      !(DECK_EVENT_CHANNELS as readonly string[]).includes(channel)
    ) {
      throw new Error(`not a subscribable deck channel: ${String(channel)}`);
    }
    return channel;
  }

  /** Validate the identity object at the realm boundary before it reaches the
   * in-process plugin context. Old guests sent only `wsId`; rejecting that
   * shape makes the API-21 incompatibility explicit instead of silently
   * binding an operation to the wrong lifetime. */
  function workspaceStorage(value: unknown) {
    if (typeof value !== "object" || value === null)
      throw new Error("workspace storage requires a workspace lifetime ref");
    const { id, instance } = value as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      id === "" ||
      typeof instance !== "string" ||
      instance === ""
    ) {
      throw new Error("workspace storage requires non-empty id and instance");
    }
    return ctx.storage.workspace({ id, instance });
  }

  const handlers: Record<string, (args: unknown[]) => unknown> = {
    // ---- storage: every operation carries the exact serializable lifetime
    // ref captured by the guest handle, never merely a reusable public id. ----
    "storage.workspace.get": ([workspace, key]) =>
      workspaceStorage(workspace).get(key as string),
    "storage.workspace.set": ([workspace, key, value]) =>
      workspaceStorage(workspace).set(key as string, value),
    "storage.workspace.delete": ([workspace, key]) =>
      workspaceStorage(workspace).delete(key as string),
    "storage.global.get": ([key]) => ctx.storage.global.get(key as string),
    "storage.global.set": ([key, value]) =>
      ctx.storage.global.set(key as string, value),
    "storage.global.delete": ([key]) =>
      ctx.storage.global.delete(key as string),

    // ---- settings: read is a plain call; onChange is a subscription ----
    "resources.path": ([relative]) =>
      ctx.resources.path(relative as string),
    "settings.read": () => ctx.settings.read(),
    "settings.onChange": () => subscriptions.subscribe("settingsChanged"),
    "settings.offChange": () => subscriptions.unsubscribe("settingsChanged"),
    "settings.registerSection": ([regId, entry]) =>
      retain(
        regId as number,
        ctx.settings.registerSection(entry as SettingsSectionContribution),
      ),

    // ---- deck events: subscribe/unsubscribe by channel name ----
    "events.subscribe": ([channel]) =>
      subscriptions.subscribe(asDeckChannel(channel)),
    "events.unsubscribe": ([channel]) =>
      subscriptions.unsubscribe(asDeckChannel(channel)),

    // ---- commands: execute/list are plain calls; register stays guest-side
    // unsupported until its first external consumer (`run` needs the
    // host→realm call cycle the agent hooks use) ----
    "commands.execute": ([id, args]) =>
      ctx.commands.execute(
        id as string,
        args as Parameters<typeof ctx.commands.execute>[1],
      ),
    "commands.list": () => ctx.commands.list(),

    // ---- ui: register the ENTRY MINUS functions; synthesise the run push ----
    "ui.registerDockTab": ([regId, entry]) =>
      retain(regId as number, ctx.ui.registerDockTab(entry as DockTabContribution)),
    "ui.registerTopBarAction": ([regId, entry]) => {
      const { id, title } = entry as { id: string; title: string };
      retain(
        regId as number,
        ctx.ui.registerTopBarAction({
          id,
          title,
          run: () => push(actionChannel("topBar", id), undefined),
        }),
      );
    },
    "ui.registerPaneAction": ([regId, entry]) => {
      const { id, title } = entry as { id: string; title: string };
      retain(
        regId as number,
        ctx.ui.registerPaneAction({
          id,
          title,
          run: (target) => push(actionChannel("pane", id), target),
        }),
      );
    },
    "ui.revealDockTab": ([id]) => ctx.ui.revealDockTab(id as string),

    // ---- notifications: fire-and-forget; the port behind ctx.notify does
    // ALL validation (capability, sanitize, rate limit) — the raw wire value
    // passes through as-is, exactly the unknown the port is built to eat ----
    "notify": ([input]) =>
      ctx.notify(input as Parameters<typeof ctx.notify>[0]),
    "ui.registerOverlay": ([regId, entry]) => {
      const { id, iframe } = entry as { id: string; iframe: unknown };
      // Only the iframe variant may arrive over the wire — a Component can't
      // exist here, and a hostile realm's junk must not either.
      if (typeof iframe !== "string" || iframe.length === 0) {
        throw new Error("external overlays must carry an `iframe` document path");
      }
      retain(regId as number, ctx.ui.registerOverlay({ id, iframe }));
    },
    "ui.setOverlayVisible": ([id, visible]) =>
      ctx.ui.setOverlayVisible(id as string, visible === true),

    // ---- file-open handlers: identity as data; open() as a host→realm proxy ----
    "openers.register": ([regId, entry]) => {
      const { id, label } = entry as { id: string; label: string };
      retain(
        regId as number,
        ctx.openers.register({
          id,
          label,
          open: (request) => callOpen(id, request),
        }),
      );
    },
    "openers.openResult": ([id, result]) => {
      // A hostile realm's word only ever gets to be a BOOLEAN: anything but
      // literal true is a decline.
      opens.settle(
        id as number,
        asRealmResult(result, (v) => ({ ok: true, value: v.handled === true })),
      );
    },

    // ---- agents: identity as data; hooks as host→realm proxies ----
    "agents.register": ([regId, entry]) => {
      const {
        id,
        label,
        icon,
        detect,
        supportsYolo,
        hookNames,
        hasHistory,
        hasListing,
        hasTranscriptPage,
        hasLiveSessions,
        usage,
      } = entry as Omit<AgentContribution, "hooks" | "history"> & {
        hookNames?: string[];
        hasHistory?: boolean;
        hasListing?: boolean;
        hasTranscriptPage?: boolean;
        hasLiveSessions?: boolean;
      };
      // Usage contributions cannot cross this boundary yet: the store calls
      // `normalize` SYNCHRONOUSLY per report, and a cross-realm proxy is
      // necessarily async. Loud, not silent — a plugin author must learn
      // this from the log, not from a chip that never appears.
      if (usage !== undefined) {
        ctx.log.warn(
          `agent "${String(id)}": usage contributions are not carried across the external tier yet — ignored`,
        );
      }
      const hooks: AgentHooks = {};
      for (const name of hookNames ?? []) {
        // Only the contract's hook names become proxies — a made-up name
        // from a hostile realm never lands on the host object.
        if (
          name !== "spawn.plan" &&
          name !== "resume.plan" &&
          name !== "fork.plan"
        )
          continue;
        hooks[name] = (input, output) => callHook(id, name, input, output);
      }
      const history: AgentHistory | undefined =
        hasHistory === true
          ? {
              list: async () =>
                requireHistoryResult(
                  "list",
                  await callHistory(id, "list", []),
                  sanitizeHistoryList,
                ),
              // Exposed ONLY on the guest's wire declaration, never
              // unconditionally like the four above: a standing proxy
              // would make `typeof listing === "function"` true for EVERY
              // external plugin, including old guests that throw on the
              // unknown method — this contract's own bug, reborn for the
              // whole external tier.
              ...(hasListing === true && {
                listing: async () =>
                  requireHistoryResult(
                    "listing",
                    await callHistory(id, "listing", []),
                    sanitizeHistoryListing,
                  ),
              }),
              describe: async (ref) =>
                requireHistoryResult(
                  "describe",
                  await callHistory(id, "describe", [ref]),
                  sanitizeHistoryFacts,
                ),
              content: async (ref) =>
                requireHistoryResult(
                  "content",
                  await callHistory(id, "content", [ref]),
                  sanitizeHistoryContent,
                ),
              transcript: async (ref, page) =>
                requireHistoryResult(
                  "transcript",
                  await callHistory(id, "transcript", [ref, page]),
                  sanitizeHistoryTranscript,
                ),
              // Negotiated exactly like `listing`, and for the same reason:
              // a standing proxy would make the method look present on every
              // external plugin, including guests that throw on it.
              ...(hasTranscriptPage === true && {
                transcriptPage: async (
                  ref: string,
                  page: { offset: number; limit: number },
                ) =>
                  requireHistoryResult(
                    "transcriptPage",
                    await callHistory(id, "transcriptPage", [ref, page]),
                    sanitizeHistoryTranscriptPage,
                  ),
              }),
            }
          : undefined;
      // Live-sessions capability, negotiated exactly like `listing`: the
      // wire flag is the ONLY basis for exposing the proxy, because a
      // standing one would get every old guest asked for a call it throws
      // on — this tier's own refusal freeze, reborn.
      const liveSessions =
        hasLiveSessions === true
          ? {
              list: async () =>
                requireLiveResult(await callLiveSessions(id), sanitizeLiveSessions),
            }
          : undefined;
      retain(
        regId as number,
        ctx.agents.register({
          id,
          label,
          icon: sanitizeAgentIcon(icon),
          detect,
          // Strictly `true`, like every boolean off the wire — anything else
          // from a hostile realm degrades to "no YOLO support".
          ...(supportsYolo === true && { supportsYolo: true }),
          hooks,
          ...(history && { history }),
          ...(liveSessions && { liveSessions }),
        }),
      );
    },
    "agents.hookResult": ([id, result]) =>
      hooks.settle(
        id as number,
        asRealmResult(result, (v) => ({ ok: true, value: v.output })),
      ),
    "agents.historyResult": ([id, result]) =>
      history.settle(
        id as number,
        asRealmResult(result, (v) => ({ ok: true, value: v.value })),
      ),
    "agents.liveResult": ([id, result]) =>
      live.settle(
        id as number,
        asRealmResult(result, (v) => ({ ok: true, value: v.value })),
      ),

    // ---- the one teardown path shared by every registration kind ----
    "registrations.dispose": ([regId]) => disposeRegistration(regId as number),

    // ---- services: a LIST, not logic — it lives in its own module ----
    ...createServiceHandlers({
      ctx,
      push,
      sessions,
      watches,
      activeDownloads,
      activeSpeechCaptures,
      isDisposed: () => disposed,
    }),

    // ---- host facts ----
    "host.settings": () => ctx.host.settings(),

    // ---- log ----
    "log.info": ([message]) => ctx.log.info(message as string),
    "log.warn": ([message]) => ctx.log.warn(message as string),
    "log.error": ([message]) => ctx.log.error(message as string),
  };

  return {
    async call(path, args) {
      // `hasOwn`, not a truthiness test on `handlers[path]`: a bare object's
      // inherited members (`constructor`, `__proto__`, `toString`) are truthy
      // and callable, so a guest calling path `"constructor"` would otherwise
      // slip past the unknown-method guard.
      if (!Object.prototype.hasOwnProperty.call(handlers, path))
        throw new Error(`unknown method: ${path}`);
      const handler = handlers[path];
      // `await` lets a promise-returning member resolve while a synchronous one
      // (a registration) has already run its side effect by this point.
      return await handler(args);
    },
    dispose() {
      disposed = true;
      // The microphone first: the app holds ONE capture slot process-wide,
      // and it was swept LAST — behind four unguarded loops, any of whose
      // disposers could throw and strand exactly the resource this sweep
      // most needs to release.
      for (const capture of activeSpeechCaptures.values()) {
        void capture.cancel().catch(() => {});
      }
      activeSpeechCaptures.clear();
      for (const pending of [hooks, history, live, opens]) {
        pending.failAll("plugin bridge disposed");
      }
      // Third-party braces from here down. One bad disposer must not abort
      // the sweep — the same per-item tolerance context.disposeAll applies.
      const swept = (label: string, run: () => void) => {
        try {
          run();
        } catch (error) {
          ctx.log.warn(`realm teardown: ${label} failed: ${String(error)}`);
        }
      };
      swept("subscriptions", () => subscriptions.disposeAll());
      swept("sessions", () => sessions.disposeAll());
      for (const disposable of registrations.values()) {
        swept("registration", () => disposable.dispose());
      }
      registrations.clear();
      for (const watcher of watches.values()) {
        swept("watch", () => watcher.dispose());
      }
      watches.clear();
      for (const id of activeDownloads) {
        void ctx.services.downloads.cancel(id).catch(() => {});
      }
      activeDownloads.clear();
    },
  };
}
