import type {
  AgentContribution,
  Disposable,
  DockTabContribution,
  FsReadFileOptions,
  PluginContext,
  PluginSpawnOptions,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";
import { actionChannel, DECK_EVENT_CHANNELS, fswatchChannel } from "./protocol";
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

    // ---- agents: identity only — hooks are functions and don't cross yet ----
    "agents.register": ([regId, entry]) => {
      const { id, label, detect } = entry as Omit<AgentContribution, "hooks">;
      retain(regId as number, ctx.agents.register({ id, label, detect, hooks: {} }));
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
      subscriptions.disposeAll();
      sessions.disposeAll();
      for (const disposable of registrations.values()) disposable.dispose();
      registrations.clear();
      for (const watcher of watches.values()) watcher.dispose();
      watches.clear();
    },
  };
}
