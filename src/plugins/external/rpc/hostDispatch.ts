import type {
  AgentContribution,
  AgentHooks,
  Disposable,
  DockTabContribution,
  FsReadFileOptions,
  PluginContext,
  PluginSpawnOptions,
  SettingsSectionContribution,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import {
  actionChannel,
  DECK_EVENT_CHANNELS,
  fswatchChannel,
  hookChannel,
  type WireHookCall,
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

  // Registrations retained by the guest-minted id that will later dispose them.
  const registrations = new Map<number, Disposable>();
  // Directory watches, retained by the guest-minted id that will unwatch them.
  const watches = new Map<number, Disposable>();
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

    // ---- agents: identity as data; hooks as host→realm proxies ----
    "agents.register": ([regId, entry]) => {
      const { id, label, detect, hookNames } = entry as Omit<
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
      retain(regId as number, ctx.agents.register({ id, label, detect, hooks }));
    },
    "agents.hookResult": ([id, result]) => {
      const settle = pendingHooks.get(id as number);
      if (!settle) return; // timed out, disposed, or never ours
      pendingHooks.delete(id as number);
      settle(result as { ok: true; output: unknown } | { ok: false; error: string });
    },

    // ---- the one teardown path shared by every registration kind ----
    "registrations.dispose": ([regId]) => disposeRegistration(regId as number),

    // ---- services ----
    "services.ports.allocate": ([key]) => ctx.services.ports.allocate(key as string),
    "services.opener.openUrl": ([url]) => ctx.services.opener.openUrl(url as string),
    "services.opener.openPath": ([path]) =>
      ctx.services.opener.openPath(path as string),
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
      subscriptions.disposeAll();
      sessions.disposeAll();
      for (const disposable of registrations.values()) disposable.dispose();
      registrations.clear();
      for (const watcher of watches.values()) watcher.dispose();
      watches.clear();
    },
  };
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
