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
    downloads: {
      start: vi.fn(async function* () {}),
      cancel: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    },
    speech: {
      engines: vi.fn(async () => ["whisper" as const]),
      startCapture: vi.fn(async () => ({
        stop: vi.fn(async () => ({ text: "", silence: true, seconds: 0, level: 0 })),
        cancel: vi.fn(async () => {}),
      })),
    },
    clipboard: {
      writeText: vi.fn(async () => {}),
      readText: vi.fn(async () => ""),
    },
    sessions: { spawn: vi.fn() },
    ports: { allocate: vi.fn() },
    opener: { openUrl: vi.fn(), openPath: vi.fn(), openPathWith: vi.fn() },
    fs: { readDir: vi.fn(), readFile: vi.fn(), watch: vi.fn(() => ({ dispose: vi.fn() })) },
    sqlite: {
      query: vi.fn(() => Promise.resolve([])),
    },
    fsWrite: {
      mkdir: vi.fn(() => Promise.resolve()),
      copyFile: vi.fn(() => Promise.resolve()),
      writeFile: vi.fn(() => Promise.resolve()),
      appendLine: vi.fn(() => Promise.resolve()),
    },
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
    notifications: vi.fn(() => vi.fn()),
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

  it("refuses an agent id another plugin already registered", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const cliManifest = (id: string) =>
      manifest(id, {
        category: "cli",
        capabilities: [{ kind: "exec", commands: ["claude"] }],
        contributes: { agents: [{ id: "claude", label: "Claude Code" }] },
      });
    const agent = {
      id: "claude",
      label: "Claude Code",
      detect: { bin: "claude" },
      hooks: {},
    };

    const first = buildPluginContext(cliManifest("first"), "builtin", registries, deps);
    first.ctx.agents.register(agent);

    // Agent ids are a global namespace — pickers and spawn resolution go by
    // id, so a silent duplicate would ride the first plugin's identity. The
    // throw lands the SECOND plugin `failed`, naming who holds the id.
    const second = buildPluginContext(cliManifest("second"), "external", registries, deps);
    expect(() => second.ctx.agents.register({ ...agent })).toThrow(
      'already registered by plugin "first"',
    );
    expect(registries.agents.list()).toHaveLength(1);

    // The holder deactivating frees the id — re-registration is not blocked
    // by a plugin that no longer owns anything.
    first.disposeAll();
    expect(() => second.ctx.agents.register({ ...agent })).not.toThrow();
  });

  it("threads storage/services/settings through the ports, namespaced by id", async () => {
    const { deps, storage, services, settingsView } = fakeDeps();
    const m = manifest("p");
    const { ctx } = buildPluginContext(m, "builtin", createContributionRegistries(), deps);

    expect(ctx.storage).toBe(storage);
    expect(deps.storage).toHaveBeenCalledWith("p");
    expect(deps.services).toHaveBeenCalledWith(m, "builtin");
    // Every service passes through as the gate built it…
    expect(ctx.services.ports).toBe(services.ports);
    expect(ctx.services.sessions).toBe(services.sessions);
    expect(ctx.services.downloads).toBe(services.downloads);
    // …except the two watches, which are wrapped so their OS watcher is
    // tracked like every other Disposable this context hands out.
    expect(ctx.services.fs.readDir).toBe(services.fs.readDir);
    expect(ctx.services.fs.watch).not.toBe(services.fs.watch);
    expect(ctx.services.git.watch).not.toBe(services.git.watch);

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

  it("disposeAll stops watches the plugin opened through ctx.services", () => {
    const { deps, services } = fakeDeps();
    const { ctx, disposeAll } = buildPluginContext(
      manifest("p"),
      "builtin",
      createContributionRegistries(),
      deps,
    );

    // A built-in may watch directly instead of going through a registration.
    // The Disposable owns an OS watcher, so it has to be torn down with the
    // rest — nothing else holds the handle after deactivate.
    ctx.services.fs.watch("/repo", () => {});
    ctx.services.git.watch("/repo", () => {});
    const fsWatch = vi.mocked(services.fs.watch).mock.results[0].value.dispose;
    const gitWatch = vi.mocked(services.git.watch).mock.results[0].value.dispose;

    disposeAll();
    expect(fsWatch).toHaveBeenCalledTimes(1);
    expect(gitWatch).toHaveBeenCalledTimes(1);
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

  it("refuses an agent whose detect.bin drifts from the manifest's declared bin", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(
      manifest("cli", {
        category: "cli",
        capabilities: [{ kind: "exec", commands: ["gemini", "gemini-next"] }],
        contributes: {
          agents: [{ id: "gemini", label: "Gemini", bin: "gemini" }],
        },
      }),
      "builtin",
      registries,
      deps,
    );
    // exec-covered but NOT the declared bin — the static declaration the
    // activation gate reads must agree with the runtime registration.
    expect(() =>
      ctx.agents.register({
        id: "gemini",
        label: "Gemini",
        detect: { bin: "gemini-next" },
        hooks: {},
      }),
    ).toThrow('does not match the manifest\'s declared bin "gemini"');
    expect(registries.agents.list()).toEqual([]);
  });

  it("matches the drift check per agent id, not by list position", () => {
    const registries = createContributionRegistries();
    const { deps } = fakeDeps();
    const { ctx } = buildPluginContext(
      manifest("cli", {
        category: "cli",
        capabilities: [{ kind: "exec", commands: ["alpha", "beta", "gamma"] }],
        contributes: {
          agents: [
            { id: "alpha", label: "Alpha", bin: "alpha" },
            { id: "beta", label: "Beta", bin: "beta" },
          ],
        },
      }),
      "builtin",
      registries,
      deps,
    );
    // The FIRST agent is fine; the SECOND drifts — a positional lookup would
    // either pass it or blame the wrong id.
    ctx.agents.register({ id: "alpha", label: "Alpha", detect: { bin: "alpha" }, hooks: {} });
    expect(() =>
      ctx.agents.register({
        id: "beta",
        label: "Beta",
        detect: { bin: "gamma" },
        hooks: {},
      }),
    ).toThrow('agent "beta"');
    expect(registries.agents.list().map((c) => c.entry.id)).toEqual(["alpha"]);
  });
});
