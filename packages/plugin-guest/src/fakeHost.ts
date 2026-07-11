import type {
  AgentContribution,
  DockTabContribution,
  FileOpenHandler,
  HostSettingsSnapshot,
  OverlayContribution,
  PaneActionContribution,
  PluginContext,
  PluginManifest,
  PluginSessionEvent,
  PluginSessionHandle,
  SettingsSectionContribution,
  TopBarActionContribution,
} from "@keepdeck/plugin-api";

/**
 * A fake `PluginContext` for driving the RPC bridge in tests — the host-side
 * peer the real host would build for a plugin. It records what a plugin
 * registers, backs storage with plain maps, lets a test FIRE deck/settings
 * events and session output, and counts how often each subscription was torn
 * down — everything the round-trip assertions need to observe both ends.
 *
 * It is not a test file itself (no `.test.` suffix) so the harness never runs it
 * as a suite; it is imported by the ones that do.
 */
export interface FakeHost {
  ctx: PluginContext;
  /** Live recorded registrations — the synthesized `run` on an action is real,
   * so a test can fire it to exercise the action push path. */
  dockTabs: DockTabContribution[];
  topBarActions: TopBarActionContribution[];
  paneActions: PaneActionContribution[];
  fileOpeners: FileOpenHandler[];
  overlays: OverlayContribution[];
  settingsSections: SettingsSectionContribution[];
  agents: AgentContribution[];
  /** Recorded `ui.revealDockTab` calls, in order. */
  revealedTabs: string[];
  /** Storage backing, so a test can inspect what a plugin persisted. */
  globalStore: Map<string, unknown>;
  workspaceStore: Map<string, unknown>;
  /** Fire a host-side event/settings change into whatever the plugin subscribed. */
  fire: {
    workspaceClosed(e: { wsId: string }): void;
    paneSelected(e: { wsId: string; paneId: string | null }): void;
    deckChanged(): void;
    settingsChanged(values: Record<string, unknown>): void;
  };
  /** How many times each subscription was disposed on the host side. */
  unsubscribes: Record<
    "workspaceClosed" | "paneSelected" | "deckChanged" | "settingsChanged",
    number
  >;
  /** Live sessions the plugin spawned, in spawn order. */
  sessions: FakeSession[];
  /** Recorded logger lines. */
  logs: { info: string[]; warn: string[]; error: string[] };
}

export interface FakeSession {
  id: string;
  writes: string[];
  resizes: [number, number][];
  closed: number;
  /** Push an event as if the backend produced it. */
  emit(event: PluginSessionEvent): void;
}

export function fakeManifest(
  id = "dev.example",
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    minApiVersion: 1,
    category: "deck",
    capabilities: [],
    contributes: {},
    ...overrides,
  };
}

export function createFakeHost(
  options: {
    settingsValues?: Record<string, unknown>;
    hostSettings?: HostSettingsSnapshot;
    manifest?: PluginManifest;
  } = {},
): FakeHost {
  const dockTabs: DockTabContribution[] = [];
  const topBarActions: TopBarActionContribution[] = [];
  const paneActions: PaneActionContribution[] = [];
  const fileOpeners: FileOpenHandler[] = [];
  const overlays: OverlayContribution[] = [];
  const settingsSections: SettingsSectionContribution[] = [];
  const agents: AgentContribution[] = [];
  const revealedTabs: string[] = [];
  const globalStore = new Map<string, unknown>();
  const workspaceStore = new Map<string, unknown>();
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const sessions: FakeSession[] = [];
  const unsubscribes = {
    workspaceClosed: 0,
    paneSelected: 0,
    deckChanged: 0,
    settingsChanged: 0,
  };

  // Listener sets a test fires into. At most one per channel is expected (the
  // guest fans out locally), but sets keep the fake honest if that changes.
  const workspaceClosedCbs = new Set<(e: { wsId: string }) => void>();
  const paneSelectedCbs = new Set<(e: { wsId: string; paneId: string | null }) => void>();
  const deckChangedCbs = new Set<() => void>();
  const settingsCbs = new Set<(v: Record<string, unknown>) => void>();

  /** Record `entry` into `into`, returning a Disposable that removes it. */
  function record<T>(into: T[], entry: T) {
    into.push(entry);
    return {
      dispose() {
        const i = into.indexOf(entry);
        if (i >= 0) into.splice(i, 1);
      },
    };
  }

  const ctx: PluginContext = {
    manifest: options.manifest ?? fakeManifest(),
    ui: {
      registerDockTab: (tab) => record(dockTabs, tab),
      registerTopBarAction: (action) => record(topBarActions, action),
      registerPaneAction: (action) => record(paneActions, action),
      registerOverlay: (overlay) => record(overlays, overlay),
      revealDockTab: (id) => {
        revealedTabs.push(id);
      },
    },
    openers: {
      register: (handler) => record(fileOpeners, handler),
    },
    settings: {
      registerSection: (section) => record(settingsSections, section),
      read: async () => options.settingsValues ?? {},
      onChange: (cb) => {
        settingsCbs.add(cb);
        return {
          dispose() {
            settingsCbs.delete(cb);
            unsubscribes.settingsChanged += 1;
          },
        };
      },
    },
    agents: {
      register: (agent) => record(agents, agent),
    },
    resources: { path: async () => null },
    storage: {
      workspace: (wsId) => ({
        get: async <T>(key: string) =>
          workspaceStore.get(`${wsId}::${key}`) as T | undefined,
        set: async (key, value) => void workspaceStore.set(`${wsId}::${key}`, value),
        delete: async (key) => void workspaceStore.delete(`${wsId}::${key}`),
      }),
      global: {
        get: async <T>(key: string) => globalStore.get(key) as T | undefined,
        set: async (key, value) => void globalStore.set(key, value),
        delete: async (key) => void globalStore.delete(key),
      },
    },
    events: {
      onWorkspaceClosed: (cb) => {
        workspaceClosedCbs.add(cb);
        return {
          dispose() {
            workspaceClosedCbs.delete(cb);
            unsubscribes.workspaceClosed += 1;
          },
        };
      },
      onPaneSelected: (cb) => {
        paneSelectedCbs.add(cb);
        return {
          dispose() {
            paneSelectedCbs.delete(cb);
            unsubscribes.paneSelected += 1;
          },
        };
      },
      onDeckChanged: (cb) => {
        deckChangedCbs.add(cb);
        return {
          dispose() {
            deckChangedCbs.delete(cb);
            unsubscribes.deckChanged += 1;
          },
        };
      },
    },
    services: {
      sessions: {
        spawn: async (_opts, onEvent) => {
          const id = `s${sessions.length + 1}`;
          const session: FakeSession = {
            id,
            writes: [],
            resizes: [],
            closed: 0,
            emit: (event) => onEvent(event),
          };
          sessions.push(session);
          const handle: PluginSessionHandle = {
            id,
            write: async (data) => void session.writes.push(data),
            resize: async (cols, rows) => void session.resizes.push([cols, rows]),
            close: async () => void (session.closed += 1),
          };
          return handle;
        },
      },
      ports: { allocate: async () => 3000 },
      opener: { openUrl: async () => {}, openPath: async () => {} },
      fs: {
        readDir: async () => [],
        readFile: async (path) => ({
          path,
          text: "",
          isBinary: false,
          size: 0,
          truncated: false,
        }),
        watch: () => ({ dispose() {} }),
      },
      git: {
        status: async () => ({
          branch: "main",
          detached: false,
          oid: null,
          upstream: null,
          ahead: null,
          behind: null,
          entries: [],
        }),
        diffFile: async () => "",
        watch: () => ({ dispose() {} }),
      },
    },
    host: {
      settings: async () => options.hostSettings ?? { terminalScrollback: 10_000 },
    },
    log: {
      info: (m) => void logs.info.push(m),
      warn: (m) => void logs.warn.push(m),
      error: (m) => void logs.error.push(m),
    },
  };

  return {
    ctx,
    dockTabs,
    topBarActions,
    paneActions,
    fileOpeners,
    overlays,
    settingsSections,
    agents,
    revealedTabs,
    globalStore,
    workspaceStore,
    fire: {
      workspaceClosed: (e) => workspaceClosedCbs.forEach((cb) => cb(e)),
      paneSelected: (e) => paneSelectedCbs.forEach((cb) => cb(e)),
      deckChanged: () => deckChangedCbs.forEach((cb) => cb()),
      settingsChanged: (v) => settingsCbs.forEach((cb) => cb(v)),
    },
    unsubscribes,
    sessions,
    logs,
  };
}
