import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  MIN_COMPATIBLE_API_VERSION,
  type KeepDeckPlugin,
  type PluginContext,
  type PluginManifest,
  type PluginServices,
  type PluginStorage,
} from "@keepdeck/plugin-api";
import {
  createContributionRegistries,
  type ContributionRegistries,
} from "../registries/contributions";
import type { InstalledPlugin, PluginStatus } from "../model/installed";
import type { PluginHostDeps } from "./deps";
import { PluginHost } from "./host";

const manifest = (
  id: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  minApiVersion: API_VERSION,
  category: "deck",
  capabilities: [],
  // Declare the tab `registrar` registers — registration is manifest-gated.
  contributes: { dockTabs: [{ id, label: id }] },
  ...overrides,
});

const spyDisposable = () => ({ dispose: vi.fn() });

function fakeDeps() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const storage: PluginStorage = {
    workspace: vi.fn(() => storage.global),
    global: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
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
  const isEnabled = vi.fn((_id: string) => true);
  const onEnabledChanged = vi.fn();
  const deps: PluginHostDeps = {
    storage: vi.fn(() => storage),
    settings: vi.fn(() => ({
      read: vi.fn(async () => ({})),
      onChange: vi.fn(spyDisposable),
    })),
    events,
    services: vi.fn(() => services),
    commands: vi.fn(() => ({
      register: vi.fn(spyDisposable),
      execute: vi.fn(async () => ({ ok: true, value: null }) as const),
      list: vi.fn(async () => []),
    })),
    resources: vi.fn(() => ({ path: vi.fn(async () => null) })),
    ui: { revealDockTab: vi.fn(), setOverlayVisible: vi.fn() },
    notifications: vi.fn(() => vi.fn()),
    log: vi.fn(() => logger),
    hostFacts: { settings: vi.fn(async () => ({ terminalScrollback: 10_000 })) },
    isEnabled,
    onEnabledChanged,
  };
  return { deps, logger, events, isEnabled, onEnabledChanged };
}

/** A plugin whose `activate` contributes one dock tab tagged with its own id —
 * enough to observe activation order and cascade cleanup. */
const registrar = (deactivate = vi.fn()): KeepDeckPlugin => ({
  activate: vi.fn((ctx: PluginContext) => {
    ctx.ui.registerDockTab({
      id: ctx.manifest.id,
      label: ctx.manifest.id,
      Component: () => null,
    });
    ctx.events.onDeckChanged(() => {});
  }),
  deactivate,
});

const statusOf = (host: PluginHost, id: string): PluginStatus | undefined =>
  host.getInstalled().find((p: InstalledPlugin) => p.manifest.id === id)
    ?.status;

const tabOwners = (registries: ContributionRegistries): string[] =>
  registries.dockTabs.list().map((c) => c.pluginId);

const allEmpty = (registries: ContributionRegistries): boolean =>
  [
    registries.dockTabs,
    registries.topBarActions,
    registries.paneActions,
    registries.settingsSections,
    registries.agents,
  ].every((r) => r.list().length === 0);

describe("PluginHost", () => {
  it("activates built-ins first, then external, in install order — contributions follow", async () => {
    const { deps } = fakeDeps();
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);

    host.install({ manifest: manifest("b2"), load: async () => registrar() }, "builtin");
    host.install({ manifest: manifest("e1"), load: async () => registrar() }, "external");
    host.install({ manifest: manifest("b1"), load: async () => registrar() }, "builtin");
    await host.activateAll();

    expect(tabOwners(registries)).toEqual(["b2", "b1", "e1"]);
    expect(statusOf(host, "e1")).toEqual({ kind: "active" });
  });

  it("is idempotent — activating an already-active plugin does not reload or re-register", async () => {
    const { deps } = fakeDeps();
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);
    const load = vi.fn(async () => registrar());
    host.install({ manifest: manifest("p"), load }, "builtin");

    await host.activate("p");
    await host.activate("p");
    expect(load).toHaveBeenCalledTimes(1);
    expect(tabOwners(registries)).toEqual(["p"]);
  });

  it("rejects a duplicate id — first install wins and the loader never runs", async () => {
    const { deps, logger } = fakeDeps();
    const host = new PluginHost(deps, createContributionRegistries());
    const first = vi.fn(async () => registrar());
    const second = vi.fn(async () => registrar());

    host.install({ manifest: manifest("p"), load: first }, "builtin");
    host.install({ manifest: manifest("p"), load: second }, "external");
    await host.activateAll();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("duplicate");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(statusOf(host, "p")).toEqual({ kind: "active" });
  });

  it("fails a plugin whose API floor is too new — before loading any code", async () => {
    const { deps } = fakeDeps();
    const host = new PluginHost(deps, createContributionRegistries());
    const load = vi.fn(async () => registrar());
    host.install(
      { manifest: manifest("p", { minApiVersion: 99 }), load },
      "external",
    );

    await host.activate("p");

    const status = statusOf(host, "p");
    expect(status?.kind).toBe("failed");
    if (status?.kind === "failed") {
      expect(status.reason).toContain("99");
      expect(status.reason).toContain(String(API_VERSION));
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("fails a plugin older than the host's compatibility window", async () => {
    const { deps } = fakeDeps();
    const host = new PluginHost(deps, createContributionRegistries());
    const load = vi.fn(async () => registrar());
    host.install(
      {
        manifest: manifest("p", {
          minApiVersion: MIN_COMPATIBLE_API_VERSION - 1,
        }),
        load,
      },
      "external",
    );

    await host.activate("p");

    expect(statusOf(host, "p")?.kind).toBe("failed");
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves ZERO residue when activate throws mid-registration", async () => {
    const { deps, events } = fakeDeps();
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);
    const activate = vi.fn((ctx: PluginContext) => {
      ctx.ui.registerDockTab({ id: "d", label: "d", Component: () => null });
      ctx.ui.registerTopBarAction({ id: "tb", title: "tb", run: () => {} });
      ctx.ui.registerPaneAction({ id: "pa", title: "pa", run: () => {} });
      ctx.settings.registerSection({ label: "s", fields: [] });
      ctx.agents.register({ id: "ag", label: "ag", detect: { bin: "x" }, hooks: {} });
      ctx.events.onDeckChanged(() => {});
      throw new Error("activate blew up");
    });
    host.install(
      {
        // Every kind declared — all registrations must land BEFORE the
        // plugin's own throw, so the sweep has real residue to clear.
        manifest: manifest("p", {
          capabilities: [{ kind: "exec", commands: ["x"] }],
          contributes: {
            dockTabs: [{ id: "d", label: "d" }],
            topBarActions: [{ id: "tb", label: "tb" }],
            paneActions: [{ id: "pa", label: "pa" }],
            settings: true,
            agents: [{ id: "ag", label: "ag" }],
          },
        }),
        load: async () => ({ activate }),
      },
      "builtin",
    );

    await host.activate("p");

    expect(allEmpty(registries)).toBe(true);
    expect(events.onDeckChanged.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
    const status = statusOf(host, "p");
    expect(status?.kind).toBe("failed");
    if (status?.kind === "failed") {
      expect(status.reason).toBe("activate blew up");
    }
  });

  it("never activates a disabled plugin", async () => {
    const { deps, isEnabled } = fakeDeps();
    isEnabled.mockReturnValue(false);
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);
    const load = vi.fn(async () => registrar());
    host.install({ manifest: manifest("p"), load }, "builtin");

    expect(statusOf(host, "p")).toEqual({ kind: "disabled" });
    await host.activateAll();
    expect(load).not.toHaveBeenCalled();
    expect(allEmpty(registries)).toBe(true);
  });

  it("deactivate cascades — hook runs, contributions and event subscriptions clear", async () => {
    const { deps, events } = fakeDeps();
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);
    const deactivate = vi.fn();
    host.install(
      { manifest: manifest("p"), load: async () => registrar(deactivate) },
      "builtin",
    );

    await host.activate("p");
    expect(tabOwners(registries)).toEqual(["p"]);

    await host.deactivate("p");
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(allEmpty(registries)).toBe(true);
    expect(events.onDeckChanged.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
    expect(statusOf(host, "p")).toEqual({ kind: "registered" });
  });

  it("a throwing deactivate hook still clears the plugin's contributions", async () => {
    const { deps } = fakeDeps();
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);
    const deactivate = vi.fn(() => {
      throw new Error("bad teardown");
    });
    host.install(
      { manifest: manifest("p"), load: async () => registrar(deactivate) },
      "builtin",
    );

    await host.activate("p");
    await host.deactivate("p");

    expect(allEmpty(registries)).toBe(true);
    expect(statusOf(host, "p")).toEqual({ kind: "registered" });
  });

  it("setEnabled(false) tears an active plugin down; setEnabled(true) re-activates it", async () => {
    const { deps, onEnabledChanged } = fakeDeps();
    const registries = createContributionRegistries();
    const host = new PluginHost(deps, registries);
    const deactivate = vi.fn();
    host.install(
      { manifest: manifest("p"), load: async () => registrar(deactivate) },
      "builtin",
    );
    await host.activate("p");

    await host.setEnabled("p", false);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(allEmpty(registries)).toBe(true);
    expect(statusOf(host, "p")).toEqual({ kind: "disabled" });
    expect(onEnabledChanged).toHaveBeenCalledWith("p", false);

    await host.setEnabled("p", true);
    expect(statusOf(host, "p")).toEqual({ kind: "active" });
    expect(tabOwners(registries)).toEqual(["p"]);
    expect(onEnabledChanged).toHaveBeenCalledWith("p", true);
  });

  it("publishes a stable installed-snapshot that changes only on real change", async () => {
    const { deps } = fakeDeps();
    const host = new PluginHost(deps, createContributionRegistries());
    const listener = vi.fn();
    host.subscribe(listener);

    const before = host.getInstalled();
    host.install({ manifest: manifest("p"), load: async () => registrar() }, "builtin");
    const afterInstall = host.getInstalled();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(afterInstall).not.toBe(before);
    expect(host.getInstalled()).toBe(afterInstall);

    await host.activate("p");
    expect(host.getInstalled()).not.toBe(afterInstall);
  });

  it("a mid-flight disable wins over the activation — disabled, zero residue", async () => {
    const { deps, registries, host } = hostWithRegistries();
    const deactivate = vi.fn();
    // A loader the test resolves by hand, holding the activation in flight.
    let release!: (plugin: KeepDeckPlugin) => void;
    const gate = new Promise<KeepDeckPlugin>((r) => {
      release = r;
    });
    host.install({ manifest: manifest("p"), load: () => gate }, "builtin");

    const activation = host.activate("p");
    await host.setEnabled("p", false);
    release(registrar(deactivate));
    await activation;

    expect(statusOf(host, "p")).toEqual({ kind: "disabled" });
    expect(allEmpty(registries)).toBe(true);
    // The fresh instance got its farewell even though it never committed.
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(deps.onEnabledChanged).toHaveBeenCalledWith("p", false);
  });

  it("a re-enable during the unwind reactivates, not left enabled-but-dead", async () => {
    const { registries, host } = hostWithRegistries();
    let releaseLoad!: (p: KeepDeckPlugin) => void;
    const loadGate = new Promise<KeepDeckPlugin>((r) => {
      releaseLoad = r;
    });
    // deactivate parks the unwind so a re-enable can land mid-teardown.
    let releaseDeact!: () => void;
    let deactEntered!: () => void;
    const entered = new Promise<void>((r) => {
      deactEntered = r;
    });
    const deactGate = new Promise<void>((r) => {
      releaseDeact = r;
    });
    const deactivate = vi.fn(() => {
      deactEntered();
      return deactGate;
    });

    host.install({ manifest: manifest("p"), load: () => loadGate }, "builtin");
    const activation = host.activate("p");
    await host.setEnabled("p", false); // disable while load() is in flight
    releaseLoad(registrar(deactivate)); // flight resumes → unwind → awaits deactivate
    await entered; // the unwind is now parked inside deactivate()
    await host.setEnabled("p", true); // re-enable DURING the unwind
    releaseDeact(); // let the unwind finish
    await activation;

    // The reconcile after the flight settles must honor the re-enable.
    expect(statusOf(host, "p")).toEqual({ kind: "active" });
    expect(tabOwners(registries)).toEqual(["p"]);
  });

  it("concurrent activations load once and register once", async () => {
    const { registries, host } = hostWithRegistries();
    let release!: (plugin: KeepDeckPlugin) => void;
    const gate = new Promise<KeepDeckPlugin>((r) => {
      release = r;
    });
    const load = vi.fn(() => gate);
    host.install({ manifest: manifest("p"), load }, "builtin");

    const first = host.activate("p");
    const second = host.activate("p");
    release(registrar());
    await Promise.all([first, second]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(tabOwners(registries)).toEqual(["p"]);
    expect(statusOf(host, "p")).toEqual({ kind: "active" });
  });
  it("uninstall tears an active plugin down and forgets it", async () => {
    const { registries, host } = hostWithRegistries();
    const deactivate = vi.fn();
    host.install(
      { manifest: manifest("p"), load: async () => registrar(deactivate) },
      "external",
    );
    await host.activate("p");

    await host.uninstall("p");

    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(allEmpty(registries)).toBe(true);
    expect(statusOf(host, "p")).toBeUndefined();
    // A later install of the same id is a fresh registration, not a dup.
    host.install({ manifest: manifest("p"), load: async () => registrar() }, "external");
    await host.activate("p");
    expect(statusOf(host, "p")).toEqual({ kind: "active" });
  });

  it("a mid-flight uninstall wins over the activation — zero residue", async () => {
    const { registries, host } = hostWithRegistries();
    let release!: (plugin: KeepDeckPlugin) => void;
    const gate = new Promise<KeepDeckPlugin>((r) => {
      release = r;
    });
    host.install({ manifest: manifest("p"), load: () => gate }, "external");

    const activation = host.activate("p");
    await host.uninstall("p");
    release(registrar());
    await activation;

    expect(statusOf(host, "p")).toBeUndefined();
    expect(allEmpty(registries)).toBe(true);
  });

  it("restart reloads: teardown, then a fresh load and re-registration", async () => {
    const { registries, host } = hostWithRegistries();
    const deactivate = vi.fn();
    const load = vi.fn(async () => registrar(deactivate));
    host.install({ manifest: manifest("p"), load }, "builtin");
    await host.activate("p");

    await host.restart("p");

    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(tabOwners(registries)).toEqual(["p"]);
    expect(statusOf(host, "p")).toEqual({ kind: "active" });
  });
});


/** Host + its registries + deps in one line, for tests that inspect all. */
function hostWithRegistries() {
  const { deps, onEnabledChanged } = fakeDeps();
  const registries = createContributionRegistries();
  const host = new PluginHost(deps, registries);
  return { deps: { ...deps, onEnabledChanged }, registries, host };
}
