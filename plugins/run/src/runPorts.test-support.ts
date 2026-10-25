import type { PluginOpener } from "@keepdeck/plugin-api";
import type { RunManager } from "./manager";
import type { RunViewPorts } from "./runtime";

const unfaked = (what: string) => new Error(`${what}: not faked in this test`);

/** An opener that refuses: a call a test did not fake rejects loudly. Spread
 * the methods a test does fake over it. */
export function openerOf(fake: Partial<PluginOpener> = {}): PluginOpener {
  return {
    openUrl: async (): Promise<never> => {
      throw unfaked("opener.openUrl");
    },
    openPath: async (): Promise<never> => {
      throw unfaked("opener.openPath");
    },
    openPathWith: async (): Promise<never> => {
      throw unfaked("opener.openPathWith");
    },
    ...fake,
  };
}

/** Ports that do nothing: an empty storage slot, events nobody fires, no
 * settings, an opener that refuses. Override the parts a test is about. */
export function inertViewPorts(over: Partial<RunViewPorts> = {}): RunViewPorts {
  return {
    storage: {
      workspace: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
    },
    events: { onDeckChanged: () => ({ dispose: () => {} }) },
    settings: {
      read: async () => ({}),
      onChange: () => ({ dispose: () => {} }),
    },
    host: {
      settings: async () => {
        throw unfaked("host.settings");
      },
    },
    services: { opener: openerOf() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
}

/** A manager that runs nothing and holds no sessions. Spread the calls a test
 * does fake over it. */
export function managerOf(fake: Partial<RunManager> = {}): RunManager {
  return {
    launchRun: async (): Promise<never> => {
      throw unfaked("manager.launchRun");
    },
    stopRun: () => {},
    restartRun: async () => {},
    removeRun: () => {},
    removeDeadRunsFor: () => {},
    stopWorkspaceRuns: () => {},
    stopAll: () => {},
    attachRun: () => () => {},
    writeRun: () => {},
    resizeRun: () => {},
    getSessions: () => [],
    subscribe: () => () => {},
    ...fake,
  };
}
