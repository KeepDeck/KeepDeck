import { describe, expect, it, vi } from "vitest";
import type {
  PluginManifest,
  PluginServices,
  PluginStorage,
} from "@keepdeck/plugin-api";
import { createContributionRegistries } from "../registries/contributions";
import { buildPluginContext } from "./context";
import type { PluginHostDeps } from "./deps";

const manifest = (
  id: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  minApiVersion: 1,
  category: "deck",
  capabilities: [],
  contributes: {},
  ...overrides,
});

/** A manifest declaring the contributions the happy-path tests register. */
const declaring = (id: string): PluginManifest =>
  manifest(id, {
    contributes: {
      dockTabs: [{ id: "t", label: "T" }],
      fileOpeners: [{ id: "peek", label: "Peek" }],
      overlays: [{ id: "viewer", label: "Viewer" }],
      commands: [{ id: "go", label: "Go" }],
      settings: true,
    },
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
    voice: {
      models: vi.fn(async () => []),
      downloadModel: vi.fn(async () => {}),
      deleteModel: vi.fn(async () => {}),
      startCapture: vi.fn(async () => {}),
      stopCapture: vi.fn(async () => ({ text: "", silence: true })),
      cancelCapture: vi.fn(async () => {}),
    },
    sessions: { spawn: vi.fn() },
    ports: { allocate: vi.fn() },
    opener: { openUrl: vi.fn(), openPath: vi.fn(), openPathWith: vi.fn() },
    fs: { readDir: vi.fn(), readFile: vi.fn(), watch: vi.fn(() => ({ dispose: vi.fn() })) },
    git: {
      status: vi.fn(),
      diffFile: vi.fn(),
      history: vi.fn(),
      branches: vi.fn(),
      changedFiles: vi.fn(),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
  const events = {
    onWorkspaceClosed: vi.fn(spyDisposable),
    onPaneSelected: vi.fn(spyDisposable),
    onDeckChanged: vi.fn(spyDisposable),
  };
  const ui = { revealDockTab: vi.fn(), setOverlayVisible: vi.fn() };
  const commandsPort = {
    register: vi.fn(spyDisposable),
    execute: vi.fn(async () => ({ ok: true, value: null }) as const),
    list: vi.fn(async () => []),
  };
  const deps: PluginHostDeps = {
    storage: vi.fn(() => storage),
    settings: vi.fn(() => settingsView),
    events,
    services: vi.fn(() => services),
    commands: vi.fn(() => commandsPort),
    resources: vi.fn(() => ({ path: vi.fn(async () => null) })),
    ui,
    log: vi.fn(() => logger),
    hostFacts: { settings: vi.fn(async () => ({ terminalScrollback: 10_000 })) },
  };
  return { deps, logger, events, settingsView, storage, services, ui, commandsPort };
}

describe("buildPluginContext", () => {
  it("routes UI and settings registrations into the matching registries, tagged by plugin", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    const tab = { id: "t", label: "T", Component: () => null };
    ctx.ui.registerDockTab(tab);
    ctx.settings.registerSection({ label: "S", fields: [] });

    expect(registries.dockTabs.list()).toEqual([{ pluginId: "p", entry: tab }]);
    expect(registries.settingsSections.list()).toEqual([
      { pluginId: "p", entry: { label: "S", fields: [] } },
    ]);
  });

  it("routes a declared file-open handler into its registry and out on dispose", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    const handler = { id: "peek", label: "Peek", open: async () => true };
    const handle = ctx.openers.register(handler);
    expect(registries.fileOpeners.list()).toEqual([
      { pluginId: "p", entry: handler },
    ]);
    handle.dispose();
    expect(registries.fileOpeners.list()).toEqual([]);

    // Undeclared id → refused, fail-closed like every contribution.
    expect(() =>
      ctx.openers.register({ id: "ghost", label: "G", open: async () => true }),
    ).toThrow('contribution not declared in the manifest: fileOpeners "ghost"');
  });

  it("routes a declared overlay into its registry and refuses an undeclared one", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    const overlay = { id: "viewer", Component: () => null };
    const handle = ctx.ui.registerOverlay(overlay);
    expect(registries.overlays.list()).toEqual([
      { pluginId: "p", entry: overlay },
    ]);
    handle.dispose();
    expect(registries.overlays.list()).toEqual([]);

    expect(() =>
      ctx.ui.registerOverlay({ id: "ghost", Component: () => null }),
    ).toThrow('contribution not declared in the manifest: overlays "ghost"');
  });

  it("routes a declared command to the port and refuses an undeclared one", () => {
    const registries = createContributionRegistries();
    const { deps, commandsPort } = fakeDeps();
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    const spec = { id: "go", title: "Go", args: [], run: () => null };
    ctx.commands.register(spec);
    expect(commandsPort.register).toHaveBeenCalledWith(spec);

    expect(() =>
      ctx.commands.register({ id: "ghost", title: "G", args: [], run: () => null }),
    ).toThrow('contribution not declared in the manifest: commands "ghost"');

    // Execute/list forward untouched — permissions live in the port.
    void ctx.commands.execute("agent.spawn", { workspace: "w" });
    expect(commandsPort.execute).toHaveBeenCalledWith("agent.spawn", {
      workspace: "w",
    });
  });

  it("forwards revealDockTab and setOverlayVisible to the host UI port with the plugin's identity", () => {
    const registries = createContributionRegistries();
    const { deps, ui } = fakeDeps();
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    ctx.ui.revealDockTab("t");
    expect(ui.revealDockTab).toHaveBeenCalledWith("p", "t");
    ctx.ui.setOverlayVisible("viewer", false);
    expect(ui.setOverlayVisible).toHaveBeenCalledWith("p", "viewer", false);
  });

  it("refuses setOverlayVisible for an UNDECLARED overlay id — no key seeding", () => {
    const registries = createContributionRegistries();
    const { deps, ui } = fakeDeps();
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    expect(() => ctx.ui.setOverlayVisible("ghost", true)).toThrow(
      'contribution not declared in the manifest: overlays "ghost"',
    );
    expect(ui.setOverlayVisible).not.toHaveBeenCalled();
  });

  it("refuses any contribution the manifest does not declare", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    // Declares tab "t" + settings — registering anything else must throw.
    const { ctx } = buildPluginContext(declaring("p"), "builtin", registries, deps);

    expect(() =>
      ctx.ui.registerDockTab({ id: "other", label: "O", Component: () => null }),
    ).toThrow('dockTabs "other"');
    expect(() =>
      ctx.ui.registerTopBarAction({ id: "a", title: "A", run() {} }),
    ).toThrow('topBarActions "a"');
    expect(registries.dockTabs.list()).toEqual([]);
    expect(registries.topBarActions.list()).toEqual([]);

    // And settings is gated by its boolean flag.
    const bare = buildPluginContext(
      manifest("q"),
      "builtin",
      registries,
      deps,
    );
    expect(() =>
      bare.ctx.settings.registerSection({ label: "S", fields: [] }),
    ).toThrow("settings");
  });

  it("agent registration passes the same declaration gate", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(
      manifest("cli", {
        category: "cli",
        capabilities: [{ kind: "exec", commands: ["claude", "codex"] }],
        contributes: { agents: [{ id: "claude", label: "Claude Code" }] },
      }),
      "builtin",
      registries,
      deps,
    );

    const agent = {
      id: "claude",
      label: "Claude Code",
      detect: { bin: "claude" },
      hooks: {},
    };
    ctx.agents.register(agent);
    expect(registries.agents.list()).toEqual([
      { pluginId: "cli", entry: agent },
    ]);
    expect(() =>
      ctx.agents.register({ ...agent, id: "codex" }),
    ).toThrow('agents "codex"');
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

describe("the agent-binary exec gate", () => {
  it("refuses an agent whose binary no exec capability covers", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(
      manifest("cli", {
        category: "cli",
        contributes: { agents: [{ id: "gemini", label: "Gemini" }] },
      }),
      "builtin",
      registries,
      deps,
    );
    expect(() =>
      ctx.agents.register({
        id: "gemini",
        label: "Gemini",
        detect: { bin: "gemini" },
        hooks: {},
      }),
    ).toThrow("exec capability");
    expect(registries.agents.list()).toEqual([]);
  });
});
