import { afterEach, describe, expect, it } from "vitest";
import type {
  Disposable,
  KeepDeckPlugin,
  PluginContext,
  PluginSessionEvent,
} from "@keepdeck/plugin-api";
// The host bridge lives in the app (`src/`), the guest in this package; a
// round-trip test is the one place both ends meet, so it reaches across the
// boundary by relative path rather than adding a workspace dependency edge.
import {
  createHostBridge,
  type HostBridge,
} from "../../../src/plugins/external/rpc/hostBridge";
import { connectPluginGuest } from "./connect";
import { createFakeHost, type FakeHost } from "./fakeHost";

/**
 * Both ends of the bridge over a real `MessageChannel`: the guest runtime builds
 * a context that proxies every call to a fake host, and the tests assert the
 * data survives the crossing and the callbacks fan back out correctly.
 */

const openPorts: MessagePort[] = [];
afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

/** Wire a plugin to a (fresh or given) fake host over a channel. */
function wire(plugin: KeepDeckPlugin, host: FakeHost = createFakeHost()) {
  const channel = new MessageChannel();
  openPorts.push(channel.port1, channel.port2);
  const bridge = createHostBridge(channel.port1, host.ctx);
  connectPluginGuest(channel.port2, plugin);
  return { host, bridge };
}

/** Wire a plugin that does nothing but hand its context back to the test, so the
 * test can drive real `ctx` members after activation. */
function wireCapturingCtx(host: FakeHost = createFakeHost()): {
  host: FakeHost;
  bridge: HostBridge;
  ctxReady: Promise<PluginContext>;
} {
  let resolve!: (ctx: PluginContext) => void;
  const ctxReady = new Promise<PluginContext>((r) => (resolve = r));
  const { bridge } = wire({ activate: (ctx) => void resolve(ctx) }, host);
  return { host, bridge, ctxReady };
}

describe("external plugin bridge", () => {
  it("activates over the handshake and lands every registration in the host", async () => {
    const plugin: KeepDeckPlugin = {
      activate(ctx) {
        ctx.ui.registerDockTab({ id: "tab", label: "Tab", iframe: "ui/panel.html" });
        ctx.ui.registerTopBarAction({ id: "bar", title: "Bar", run: () => {} });
        ctx.ui.registerPaneAction({ id: "pane", title: "Pane", run: () => {} });
        ctx.settings.registerSection({ label: "Sec", fields: [] });
        ctx.agents.register({
          id: "ag",
          label: "Ag",
          detect: { bin: "ag" },
          hooks: {},
        });
      },
    };
    const { host, bridge } = wire(plugin);

    await bridge.activated;

    expect(host.dockTabs).toEqual([
      { id: "tab", label: "Tab", iframe: "ui/panel.html" },
    ]);
    expect(host.topBarActions.map((a) => ({ id: a.id, title: a.title }))).toEqual([
      { id: "bar", title: "Bar" },
    ]);
    expect(host.paneActions.map((a) => ({ id: a.id, title: a.title }))).toEqual([
      { id: "pane", title: "Pane" },
    ]);
    expect(host.settingsSections).toEqual([{ label: "Sec", fields: [] }]);
    expect(host.agents).toEqual([
      { id: "ag", label: "Ag", detect: { bin: "ag" }, hooks: {} },
    ]);
  });

  it("reports `failed` when activation registers a Component dock tab", async () => {
    const plugin: KeepDeckPlugin = {
      activate(ctx) {
        ctx.ui.registerDockTab({ id: "t", label: "T", Component: () => null });
      },
    };
    const { host, bridge } = wire(plugin);

    await expect(bridge.activated).rejects.toThrow(/iframe/);
    expect(host.dockTabs).toHaveLength(0);
  });

  it("round-trips storage values with nesting intact, at both scopes", async () => {
    const { host, ctxReady } = wireCapturingCtx();
    const ctx = await ctxReady;

    const nested = { a: { b: [1, 2, { c: "d" }] }, e: true };
    await ctx.storage.global.set("k", nested);
    expect(await ctx.storage.global.get("k")).toEqual(nested);
    expect(host.globalStore.get("k")).toEqual(nested);

    const wsValue = { list: [3, 4] };
    await ctx.storage.workspace("w1").set("x", wsValue);
    expect(await ctx.storage.workspace("w1").get("x")).toEqual(wsValue);
    // Namespaced by workspace: a different workspace does not see it.
    expect(await ctx.storage.workspace("w2").get("x")).toBeUndefined();
  });

  it("delivers a subscribed deck event and unsubscribes on the host when disposed", async () => {
    const host = createFakeHost();
    const received: { wsId: string }[] = [];
    let disposable: Disposable | undefined;
    const plugin: KeepDeckPlugin = {
      activate(ctx) {
        disposable = ctx.events.onWorkspaceClosed((e) => received.push(e));
      },
    };
    const { bridge } = wire(plugin, host);
    await bridge.activated;
    await flush();

    host.fire.workspaceClosed({ wsId: "w1" });
    await flush();
    expect(received).toEqual([{ wsId: "w1" }]);

    disposable?.dispose();
    await flush();
    expect(host.unsubscribes.workspaceClosed).toBe(1);

    host.fire.workspaceClosed({ wsId: "w2" });
    await flush();
    expect(received).toEqual([{ wsId: "w1" }]);
  });

  it("delivers settings changes and unsubscribes on dispose", async () => {
    const host = createFakeHost();
    const seen: Record<string, unknown>[] = [];
    let disposable: Disposable | undefined;
    const plugin: KeepDeckPlugin = {
      activate(ctx) {
        disposable = ctx.settings.onChange((values) => seen.push(values));
      },
    };
    const { bridge } = wire(plugin, host);
    await bridge.activated;
    await flush();

    host.fire.settingsChanged({ theme: "dark" });
    await flush();
    expect(seen).toEqual([{ theme: "dark" }]);

    disposable?.dispose();
    await flush();
    expect(host.unsubscribes.settingsChanged).toBe(1);

    host.fire.settingsChanged({ theme: "light" });
    await flush();
    expect(seen).toHaveLength(1);
  });

  it("spawns a session, re-hydrates output to a Uint8Array, and routes write/close by id", async () => {
    const { host, ctxReady } = wireCapturingCtx();
    const ctx = await ctxReady;

    const events: PluginSessionEvent[] = [];
    const handle = await ctx.services.sessions.spawn(
      { cols: 80, rows: 24 },
      (event) => events.push(event),
    );
    expect(host.sessions).toHaveLength(1);
    expect(handle.id).toBe("s1");

    host.sessions[0].emit({ type: "output", bytes: new Uint8Array([1, 2, 3]) });
    await flush();
    const output = events[0];
    expect(output.type).toBe("output");
    if (output.type === "output") {
      expect(output.bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(output.bytes)).toEqual([1, 2, 3]);
    }

    host.sessions[0].emit({ type: "exit", code: 0 });
    await flush();
    expect(events[1]).toEqual({ type: "exit", code: 0 });

    await handle.write("hello");
    expect(host.sessions[0].writes).toEqual(["hello"]);
    await handle.resize(100, 40);
    expect(host.sessions[0].resizes).toEqual([[100, 40]]);
    await handle.close();
    expect(host.sessions[0].closed).toBe(1);
  });

  it("closes still-open session handles when the bridge is disposed", async () => {
    const { host, bridge, ctxReady } = wireCapturingCtx();
    const ctx = await ctxReady;

    await ctx.services.sessions.spawn({ cols: 80, rows: 24 }, () => {});
    expect(host.sessions[0].closed).toBe(0);

    bridge.dispose();
    await flush();
    expect(host.sessions[0].closed).toBe(1);
  });

  it("fans a top-bar action's host-side run back to the plugin's callback", async () => {
    const host = createFakeHost();
    let runs = 0;
    const plugin: KeepDeckPlugin = {
      activate(ctx) {
        ctx.ui.registerTopBarAction({ id: "a", title: "A", run: () => void (runs += 1) });
      },
    };
    const { bridge } = wire(plugin, host);
    await bridge.activated;

    expect(host.topBarActions).toHaveLength(1);
    host.topBarActions[0].run();
    await flush();
    expect(runs).toBe(1);
  });

  it("rejects the guest promise with the message of a throwing host member", async () => {
    const host = createFakeHost();
    host.ctx.storage.global.get = () => {
      throw new Error("boom");
    };
    const { ctxReady } = wireCapturingCtx(host);
    const ctx = await ctxReady;

    await expect(ctx.storage.global.get("k")).rejects.toThrow("boom");
  });

  it("rejects in-flight guest calls when the bridge is disposed", async () => {
    const host = createFakeHost();
    host.ctx.services.ports.allocate = () => new Promise<number>(() => {});
    const { bridge, ctxReady } = wireCapturingCtx(host);
    const ctx = await ctxReady;

    const pending = ctx.services.ports.allocate("k");
    await flush();
    bridge.dispose();

    await expect(pending).rejects.toThrow(/disposed/);
  });
});
