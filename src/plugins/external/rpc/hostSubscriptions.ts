import type { Disposable, PluginContext } from "@keepdeck/plugin-api";

/**
 * The host end of the guest's subscriptions. A guest fans a channel out to many
 * local listeners itself, so it only ever asks the host to attach ONE real
 * subscription per channel — this manager holds exactly that: at most one live
 * `Disposable` per channel name, keyed so an `unsubscribe` (or the bridge dying)
 * tears down precisely the right one.
 *
 * The four channels a guest can attach — the three deck events plus the
 * settings-change feed — differ only in which `ctx` member they wire to, so the
 * knowledge lives in one lookup table and `subscribe`/`unsubscribe` stay generic
 * (the built-in tier's `buildPluginContext` tracks the same subscriptions the
 * same way; this is that pattern with the callback replaced by a `push`).
 */
export interface HostSubscriptions {
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
  disposeAll(): void;
}

export function createHostSubscriptions(
  ctx: PluginContext,
  push: (channel: string, payload: unknown) => void,
): HostSubscriptions {
  // How to attach each channel to the real context. Adding a channel is one
  // line here; the dispatch validates the name before it reaches us.
  const attach: Record<string, () => Disposable> = {
    workspaceClosed: () =>
      ctx.events.onWorkspaceClosed((e) => push("workspaceClosed", e)),
    paneSelected: () =>
      ctx.events.onPaneSelected((e) => push("paneSelected", e)),
    deckChanged: () => ctx.events.onDeckChanged(() => push("deckChanged", undefined)),
    settingsChanged: () => ctx.settings.onChange((v) => push("settingsChanged", v)),
  };

  const live = new Map<string, Disposable>();

  return {
    subscribe(channel) {
      const factory = attach[channel];
      if (!factory) throw new Error(`unknown event channel: ${channel}`);
      // Idempotent: a second subscribe for a channel already attached is a
      // no-op, so a guest that double-subscribes never leaks a duplicate.
      if (live.has(channel)) return;
      live.set(channel, factory());
    },
    unsubscribe(channel) {
      const disposable = live.get(channel);
      if (!disposable) return;
      live.delete(channel);
      disposable.dispose();
    },
    disposeAll() {
      for (const disposable of live.values()) disposable.dispose();
      live.clear();
    },
  };
}
