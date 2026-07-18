import type {
  AgentContribution,
  AgentHooks,
  AgentIcon,
  AgentIconPath,
  Disposable,
  DownloadRequest,
  DownloadState,
  DownloadTarget,
  DockTabContribution,
  FsReadFileOptions,
  GitDiffOptions,
  GitHistoryOptions,
  PluginContext,
  PluginSpawnOptions,
  SpeechCapture,
  SpeechCaptureOptions,
  SettingsSectionContribution,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import {
  actionChannel,
  DECK_EVENT_CHANNELS,
  downloadChannel,
  fswatchChannel,
  hookChannel,
  openChannel,
  speechLevelChannel,
  type WireHookCall,
  type WireOpenCall,
  type WireSpawnPlanOutput,
} from "./protocol";
import { createHostSessions } from "./hostSessions";
import { createHostSubscriptions } from "./hostSubscriptions";

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

  // Agent-hook invocations awaiting their `agents.hookResult` reply. A hung
  // or dead realm must not freeze the spawn pipeline: each call carries a
  // timeout, and `dispose` fails whatever is still pending.
  const HOOK_TIMEOUT_MS = 10_000;
  let nextHookId = 1;
  const pendingHooks = new Map<
    number,
    (result: { ok: true; output: unknown } | { ok: false; error: string }) => void
  >();

  /** Run ONE hook in the realm: push the call, await the correlated result,
   * copy the sanitized mutated output back into the caller's object — the
   * in-process mutate-in-place contract, preserved across the wire. */
  function callHook(
    agentId: string,
    hook: string,
    input: unknown,
    output: SpawnPlanOutput,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = nextHookId++;
      const timer = setTimeout(() => {
        if (pendingHooks.delete(id))
          reject(new Error(`${hook} timed out after ${HOOK_TIMEOUT_MS}ms`));
      }, HOOK_TIMEOUT_MS);
      pendingHooks.set(id, (result) => {
        clearTimeout(timer);
        if (!result.ok) return reject(new Error(result.error));
        // The realm's word shapes a SPAWN — nothing but plain strings may
        // come back, whatever a hostile realm actually sent.
        const mutated = sanitizePlanOutput(result.output);
        if (!mutated) return reject(new Error(`${hook} returned a malformed plan`));
        Object.assign(output, mutated);
        resolve();
      });
      const call: WireHookCall = { agentId, hook, input, output };
      push(hookChannel(id), call);
    });
  }

  // File-open invocations awaiting their `openers.openResult` reply — the
  // agent-hook pattern, but the stake is a CLICK: a hung or dead realm must
  // not strand it, so a timeout settles the proxy as a rejection, which the
  // host's file-open chain logs and treats as a decline (the system opener
  // takes the file). Tighter than the hook timeout — a user is watching.
  const OPEN_TIMEOUT_MS = 5_000;
  let nextOpenId = 1;
  const pendingOpens = new Map<
    number,
    (result: { ok: true; handled: boolean } | { ok: false; error: string }) => void
  >();

  /** Ask the realm's handler about ONE file-open request. */
  function callOpen(handlerId: string, request: { path: string }): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = nextOpenId++;
      const timer = setTimeout(() => {
        if (pendingOpens.delete(id))
          reject(
            new Error(
              `file-open handler "${handlerId}" timed out after ${OPEN_TIMEOUT_MS}ms`,
            ),
          );
      }, OPEN_TIMEOUT_MS);
      pendingOpens.set(id, (result) => {
        clearTimeout(timer);
        if (!result.ok) return reject(new Error(result.error));
        // A hostile realm's word only ever gets to be a BOOLEAN: anything
        // but literal true is a decline.
        resolve(result.handled === true);
      });
      const call: WireOpenCall = { handlerId, request };
      push(openChannel(id), call);
    });
  }

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

  const handlers: Record<string, (args: unknown[]) => unknown> = {
    // ---- storage: workspace scope needs the id as its leading argument ----
    "storage.workspace.get": ([wsId, key]) =>
      ctx.storage.workspace(wsId as string).get(key as string),
    "storage.workspace.set": ([wsId, key, value]) =>
      ctx.storage.workspace(wsId as string).set(key as string, value),
    "storage.workspace.delete": ([wsId, key]) =>
      ctx.storage.workspace(wsId as string).delete(key as string),
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
      const settle = pendingOpens.get(id as number);
      if (!settle) return; // timed out, disposed, or never ours
      pendingOpens.delete(id as number);
      settle(
        asRealmResult(result, (v) => ({ ok: true, handled: v.handled === true })),
      );
    },

    // ---- agents: identity as data; hooks as host→realm proxies ----
    "agents.register": ([regId, entry]) => {
      const { id, label, icon, detect, supportsYolo, hookNames } = entry as Omit<
        AgentContribution,
        "hooks"
      > & { hookNames?: string[] };
      const hooks: AgentHooks = {};
      for (const name of hookNames ?? []) {
        // Only the contract's hook names become proxies — a made-up name
        // from a hostile realm never lands on the host object.
        if (name !== "spawn.plan" && name !== "resume.plan") continue;
        hooks[name] = (input, output) => callHook(id, name, input, output);
      }
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
        }),
      );
    },
    "agents.hookResult": ([id, result]) => {
      const settle = pendingHooks.get(id as number);
      if (!settle) return; // timed out, disposed, or never ours
      pendingHooks.delete(id as number);
      settle(asRealmResult(result, (v) => ({ ok: true, output: v.output })));
    },

    // ---- the one teardown path shared by every registration kind ----
    "registrations.dispose": ([regId]) => disposeRegistration(regId as number),

    // ---- services ----
    "services.ports.allocate": ([key]) => ctx.services.ports.allocate(key as string),
    "services.opener.openUrl": ([url]) => ctx.services.opener.openUrl(url as string),
    "services.opener.openPath": ([path]) =>
      ctx.services.opener.openPath(path as string),
    "services.opener.openPathWith": ([path, application]) =>
      ctx.services.opener.openPathWith(path as string, application as string),
    "services.sessions.spawn": ([opts]) =>
      sessions.spawn(opts as PluginSpawnOptions),
    "services.sessions.write": ([id, data]) =>
      sessions.write(id as string, data as string),
    "services.sessions.resize": ([id, cols, rows]) =>
      sessions.resize(id as string, cols as number, rows as number),
    "services.sessions.close": ([id]) => sessions.close(id as string),
    "services.fs.readDir": ([path]) => ctx.services.fs.readDir(path as string),
    "services.fs.readFile": ([path, opts]) =>
      ctx.services.fs.readFile(
        path as string,
        opts as FsReadFileOptions | undefined,
      ),
    // A watch is a subscription: the guest mints the id, the host holds the
    // Disposable under it and pushes `fswatch:<id>` on each change.
    "services.fs.watch": ([id, path]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.set(
        key,
        ctx.services.fs.watch(path as string, () =>
          push(fswatchChannel(key), undefined),
        ),
      );
    },
    "services.fs.unwatch": ([id]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.delete(key);
    },
    "services.git.status": ([repo]) => ctx.services.git.status(repo as string),
    "services.git.history": ([repo, opts]) =>
      ctx.services.git.history(
        repo as string,
        opts as GitHistoryOptions | undefined,
      ),
    "services.git.branches": ([repo]) =>
      ctx.services.git.branches(repo as string),
    "services.git.changedFiles": ([repo, from, to]) =>
      ctx.services.git.changedFiles(
        repo as string,
        from as string,
        to as string | undefined,
      ),
    "services.git.diffFile": ([repo, file, opts]) =>
      ctx.services.git.diffFile(
        repo as string,
        file as string,
        opts as GitDiffOptions | undefined,
      ),
    // Git watches share the fs watches' plumbing: same guest-minted id space
    // (one counter mints both), same retained-Disposable map, same
    // `fswatch:<id>` push channel — a watch is a watch, only the backend
    // differs.
    "services.git.watch": ([id, repo]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.set(
        key,
        ctx.services.git.watch(repo as string, () =>
          push(fswatchChannel(key), undefined),
        ),
      );
    },
    "services.git.unwatch": ([id]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.delete(key);
    },
    "services.downloads.start": ([raw]) => {
      const request = raw as DownloadRequest;
      const stream = ctx.services.downloads.start(request);
      activeDownloads.add(request.id);
      void (async () => {
        try {
          for await (const state of stream) {
            push(downloadChannel(request.id), state);
          }
        } catch (error) {
          const failed: DownloadState = {
            id: request.id,
            phase: "failed",
            received: 0,
            total: request.integrity?.bytes ?? null,
            error: error instanceof Error ? error.message : String(error),
          };
          push(downloadChannel(request.id), failed);
        } finally {
          activeDownloads.delete(request.id);
        }
      })();
    },
    "services.downloads.cancel": ([id]) =>
      ctx.services.downloads.cancel(id as string),
    "services.downloads.exists": ([target, integrity]) =>
      ctx.services.downloads.exists(
        target as DownloadTarget,
        integrity as DownloadRequest["integrity"],
      ),
    "services.downloads.remove": ([target]) =>
      ctx.services.downloads.remove(target as DownloadTarget),
    "services.speech.engines": () => ctx.services.speech.engines(),
    "services.speech.start": async ([id]) => {
      const key = id as number;
      if (activeSpeechCaptures.has(key)) {
        throw new Error(`speech capture id already active: ${key}`);
      }
      const capture = await ctx.services.speech.startCapture((level) =>
        push(speechLevelChannel(key), level),
      );
      activeSpeechCaptures.set(key, capture);
    },
    "services.speech.stop": ([id, opts]) => {
      const key = id as number;
      const capture = activeSpeechCaptures.get(key);
      if (!capture) throw new Error(`speech capture is not active: ${key}`);
      activeSpeechCaptures.delete(key);
      return capture.stop(opts as SpeechCaptureOptions);
    },
    "services.speech.cancel": ([id]) => {
      const key = id as number;
      const capture = activeSpeechCaptures.get(key);
      if (!capture) return;
      activeSpeechCaptures.delete(key);
      return capture.cancel();
    },

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
      for (const settle of pendingHooks.values()) {
        settle({ ok: false, error: "plugin bridge disposed" });
      }
      pendingHooks.clear();
      for (const settle of pendingOpens.values()) {
        settle({ ok: false, error: "plugin bridge disposed" });
      }
      pendingOpens.clear();
      subscriptions.disposeAll();
      sessions.disposeAll();
      for (const disposable of registrations.values()) disposable.dispose();
      registrations.clear();
      for (const watcher of watches.values()) watcher.dispose();
      watches.clear();
      for (const id of activeDownloads) {
        void ctx.services.downloads.cancel(id).catch(() => {});
      }
      activeDownloads.clear();
      for (const capture of activeSpeechCaptures.values()) {
        void capture.cancel().catch(() => {});
      }
      activeSpeechCaptures.clear();
    },
  };
}

/**
 * Shape a realm's reply BEFORE it may settle a pending host→realm call. The
 * settle callbacks run after `clearTimeout` — a `result.ok` read throwing on
 * junk (`[id]` with no result, `null`, a primitive) would strand the pending
 * promise FOREVER, past the very timeout built to prevent hangs. So junk
 * becomes an explicit failure, and only a literal `ok: true` reaches `onOk`.
 */
function asRealmResult<T extends { ok: true }>(
  value: unknown,
  onOk: (v: Record<string, unknown>) => T,
): T | { ok: false; error: string } {
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.ok === true) return onOk(v);
    if (v.ok === false) {
      return {
        ok: false,
        error: typeof v.error === "string" ? v.error : "realm reported a failure",
      };
    }
  }
  return { ok: false, error: "malformed result from the realm" };
}

/** Accept a realm-supplied agent icon only in the contract's exact shape —
 * plain strings bound for SVG attributes; an off-shape layer drops, and an
 * icon with nothing left drops to `undefined` (no icon) rather than refusing
 * the registration. */
function sanitizeAgentIcon(value: unknown): AgentIcon | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.viewBox !== "string" || !Array.isArray(v.paths))
    return undefined;
  const paths = v.paths.flatMap((layer): AgentIconPath[] => {
    if (typeof layer !== "object" || layer === null) return [];
    const l = layer as Record<string, unknown>;
    if (typeof l.d !== "string") return [];
    return [
      {
        d: l.d,
        ...(typeof l.color === "string" ? { color: l.color } : {}),
        ...(l.fillRule === "evenodd" ? { fillRule: l.fillRule } : {}),
      },
    ];
  });
  if (paths.length === 0) return undefined;
  return { viewBox: v.viewBox, paths };
}

/** Validate a realm-returned plan output down to plain strings; `null` when
 * anything is off-shape. */
function sanitizePlanOutput(value: unknown): WireSpawnPlanOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.command !== null && typeof v.command !== "string") return null;
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === "string"))
    return null;
  if (
    !Array.isArray(v.env) ||
    !v.env.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((x) => typeof x === "string"),
    )
  )
    return null;
  return {
    command: v.command as string | null,
    args: v.args as string[],
    env: v.env as [string, string][],
  };
}
