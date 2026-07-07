import { describe, expect, it, vi } from "vitest";
import type {
  PluginManifest,
  PluginServices,
  PluginStorage,
} from "@keepdeck/plugin-api";
import { createContributionRegistries } from "../registries/contributions";
import { buildPluginContext } from "./context";
import type { PluginHostDeps } from "./deps";

const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  minApiVersion: "0.0.1",
  capabilities: [],
  contributes: {},
});

/** A disposable whose `dispose` is a spy — lets a test assert exactly how many
 * times an event subscription was torn down. */
const spyDisposable = () => ({ dispose: vi.fn() });

function fakeDeps() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const storage: PluginStorage = {
    workspace: vi.fn(() => storage.global),
    global: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  };
  const settingsView = {
    read: vi.fn(async () => ({})),
    onChange: vi.fn(spyDisposable),
  };
  const services: PluginServices = {
    sessions: { spawn: vi.fn() },
    ports: { allocate: vi.fn() },
    opener: { openUrl: vi.fn(), openPath: vi.fn() },
    fs: { readDir: vi.fn(), readFile: vi.fn(), watch: vi.fn(() => ({ dispose: vi.fn() })) },
  };
  const events = {
    onWorkspaceClosed: vi.fn(spyDisposable),
    onPaneSelected: vi.fn(spyDisposable),
    onDeckChanged: vi.fn(spyDisposable),
  };
  const deps: PluginHostDeps = {
    storage: vi.fn(() => storage),
    settings: vi.fn(() => settingsView),
    events,
    services: vi.fn(() => services),
    log: vi.fn(() => logger),
    hostFacts: { settings: vi.fn(async () => ({ terminalScrollback: 10_000 })) },
  };
  return { deps, logger, events, settingsView, storage, services };
}

describe("buildPluginContext", () => {
  it("routes UI/settings/agent registrations into the matching registries, tagged by plugin", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(manifest("p"), "builtin", registries, deps);

    const tab = { id: "t", label: "T", Component: () => null };
    ctx.ui.registerDockTab(tab);
    ctx.settings.registerSection({ label: "S", fields: [] });

    expect(registries.dockTabs.list()).toEqual([{ pluginId: "p", entry: tab }]);
    expect(registries.settingsSections.list()).toEqual([
      { pluginId: "p", entry: { label: "S", fields: [] } },
    ]);
  });

  it("threads storage/services/settings through the ports, namespaced by id", async () => {
    const { deps, storage, services, settingsView } = fakeDeps();
    const m = manifest("p");
    const { ctx } = buildPluginContext(m, "builtin", createContributionRegistries(), deps);

    expect(ctx.storage).toBe(storage);
    expect(deps.storage).toHaveBeenCalledWith("p");
    expect(ctx.services).toBe(services);
    expect(deps.services).toHaveBeenCalledWith(m, "builtin");

    await ctx.settings.read();
    expect(settingsView.read).toHaveBeenCalledTimes(1);
  });

  it("disposeAll tears down every outstanding subscription once", () => {
    const { deps, events } = fakeDeps();
    const { ctx, disposeAll } = buildPluginContext(
      manifest("p"),
      "builtin",
      createContributionRegistries(),
      deps,
    );

    ctx.events.onDeckChanged(() => {});
    ctx.events.onPaneSelected(() => {});
    const deck = events.onDeckChanged.mock.results[0].value.dispose;
    const pane = events.onPaneSelected.mock.results[0].value.dispose;

    disposeAll();
    expect(deck).toHaveBeenCalledTimes(1);
    expect(pane).toHaveBeenCalledTimes(1);
  });

  it("an early manual dispose retires the brace — disposeAll never runs it again", () => {
    const { deps, events } = fakeDeps();
    const { ctx, disposeAll } = buildPluginContext(
      manifest("p"),
      "builtin",
      createContributionRegistries(),
      deps,
    );

    const handle = ctx.events.onDeckChanged(() => {});
    const inner = events.onDeckChanged.mock.results[0].value.dispose;

    handle.dispose();
    expect(inner).toHaveBeenCalledTimes(1);
    disposeAll();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("a throwing disposer is logged and does not abort the sweep", () => {
    const { deps, events, logger } = fakeDeps();
    const boom = {
      dispose: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const ok = spyDisposable();
    events.onDeckChanged.mockReturnValueOnce(boom).mockReturnValueOnce(ok);

    const { ctx, disposeAll } = buildPluginContext(
      manifest("p"),
      "builtin",
      createContributionRegistries(),
      deps,
    );
    ctx.events.onDeckChanged(() => {});
    ctx.events.onDeckChanged(() => {});

    expect(() => disposeAll()).not.toThrow();
    expect(boom.dispose).toHaveBeenCalledTimes(1);
    expect(ok.dispose).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
