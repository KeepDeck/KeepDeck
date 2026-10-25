import type { PluginContext, PluginServices } from "@keepdeck/plugin-api";

/**
 * A whole, typed `PluginContext` for a test that drives only a few members of
 * it — the RPC dispatch, which bridges the entire context, above all. The
 * test names what it fakes; every other member is there, typed, and fails
 * loudly by name if anything calls it. A test used to build the members it
 * needed and cast the half-object to a context, which hid any member the code
 * began to use from the compiler and from the reader.
 */

/** Context members a test may fake: a function member whole, an object member
 * by any of its own members — and the services one service member at a time. */
export type PluginContextFake = {
  [K in Exclude<keyof PluginContext, "services">]?: PluginContext[K] extends (
    ...args: never[]
  ) => unknown
    ? PluginContext[K]
    : Partial<PluginContext[K]>;
} & {
  services?: { [S in keyof PluginServices]?: Partial<PluginServices[S]> };
};

/** A member the test did not fake. Taking nothing and returning `never`, it
 * fits every method's type; called, it names itself. */
function unfaked(path: string): () => never {
  return () => {
    throw new Error(`${path} is not faked in this test`);
  };
}

function unfakedKv(path: string) {
  return {
    get: unfaked(`${path}.get`),
    set: unfaked(`${path}.set`),
    delete: unfaked(`${path}.delete`),
  };
}

export function fakePluginContext(fake: PluginContextFake = {}): PluginContext {
  const services = fake.services ?? {};
  return {
    manifest: {
      id: "dev.example",
      name: "Example",
      version: "1.0.0",
      minApiVersion: 1,
      category: "deck",
      capabilities: [],
      contributes: {},
      ...fake.manifest,
    },
    ui: {
      registerDockTab: unfaked("ui.registerDockTab"),
      registerOverlay: unfaked("ui.registerOverlay"),
      setOverlayVisible: unfaked("ui.setOverlayVisible"),
      setOverlayCovers: unfaked("ui.setOverlayCovers"),
      registerTopBarAction: unfaked("ui.registerTopBarAction"),
      registerPaneAction: unfaked("ui.registerPaneAction"),
      ...fake.ui,
    },
    openers: { register: unfaked("openers.register"), ...fake.openers },
    settings: {
      registerSection: unfaked("settings.registerSection"),
      read: unfaked("settings.read"),
      write: unfaked("settings.write"),
      onChange: unfaked("settings.onChange"),
      ...fake.settings,
    },
    agents: { register: unfaked("agents.register"), ...fake.agents },
    commands: {
      register: unfaked("commands.register"),
      execute: unfaked("commands.execute"),
      list: unfaked("commands.list"),
      ...fake.commands,
    },
    storage: {
      workspace: unfaked("storage.workspace"),
      global: unfakedKv("storage.global"),
      ...fake.storage,
    },
    resources: { path: unfaked("resources.path"), ...fake.resources },
    events: {
      onWorkspaceClosed: unfaked("events.onWorkspaceClosed"),
      onPaneSelected: unfaked("events.onPaneSelected"),
      onDeckChanged: unfaked("events.onDeckChanged"),
      ...fake.events,
    },
    services: {
      sessions: { spawn: unfaked("services.sessions.spawn"), ...services.sessions },
      exec: { runOnce: unfaked("services.exec.runOnce"), ...services.exec },
      ports: { allocate: unfaked("services.ports.allocate"), ...services.ports },
      opener: {
        openUrl: unfaked("services.opener.openUrl"),
        openPath: unfaked("services.opener.openPath"),
        openPathWith: unfaked("services.opener.openPathWith"),
        ...services.opener,
      },
      fs: {
        readDir: unfaked("services.fs.readDir"),
        readFile: unfaked("services.fs.readFile"),
        watch: unfaked("services.fs.watch"),
        ...services.fs,
      },
      fsWrite: {
        mkdir: unfaked("services.fsWrite.mkdir"),
        copyFile: unfaked("services.fsWrite.copyFile"),
        remove: unfaked("services.fsWrite.remove"),
        writeFile: unfaked("services.fsWrite.writeFile"),
        appendLine: unfaked("services.fsWrite.appendLine"),
        ...services.fsWrite,
      },
      sqlite: { query: unfaked("services.sqlite.query"), ...services.sqlite },
      sessionStore: { read: unfaked("services.sessionStore.read"), ...services.sessionStore },
      git: {
        status: unfaked("services.git.status"),
        diffFile: unfaked("services.git.diffFile"),
        history: unfaked("services.git.history"),
        branches: unfaked("services.git.branches"),
        changedFiles: unfaked("services.git.changedFiles"),
        watch: unfaked("services.git.watch"),
        ...services.git,
      },
      downloads: {
        start: unfaked("services.downloads.start"),
        cancel: unfaked("services.downloads.cancel"),
        exists: unfaked("services.downloads.exists"),
        remove: unfaked("services.downloads.remove"),
        ...services.downloads,
      },
      speech: {
        engines: unfaked("services.speech.engines"),
        devices: unfaked("services.speech.devices"),
        startCapture: unfaked("services.speech.startCapture"),
        ...services.speech,
      },
      clipboard: {
        writeText: unfaked("services.clipboard.writeText"),
        readText: unfaked("services.clipboard.readText"),
        ...services.clipboard,
      },
    },
    host: { settings: unfaked("host.settings"), ...fake.host },
    log: {
      info: unfaked("log.info"),
      warn: unfaked("log.warn"),
      error: unfaked("log.error"),
      ...fake.log,
    },
    notify: fake.notify ?? unfaked("notify"),
  };
}
