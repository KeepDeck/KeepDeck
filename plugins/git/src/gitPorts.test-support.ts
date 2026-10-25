import type { PluginGit } from "@keepdeck/plugin-api";
import type { GitPorts } from "./runtime";

const unfaked = (what: string) => new Error(`${what}: not faked in this test`);

/** A git service that answers nothing: a call a test did not fake rejects
 * loudly, where an absent method would be a bare "is not a function". Spread
 * the methods a test does fake over it. */
export function gitOf(fake: Partial<PluginGit> = {}): PluginGit {
  return {
    status: async (): Promise<never> => {
      throw unfaked("git.status");
    },
    diffFile: async (): Promise<never> => {
      throw unfaked("git.diffFile");
    },
    history: async (): Promise<never> => {
      throw unfaked("git.history");
    },
    branches: async (): Promise<never> => {
      throw unfaked("git.branches");
    },
    changedFiles: async (): Promise<never> => {
      throw unfaked("git.changedFiles");
    },
    watch: (): never => {
      throw unfaked("git.watch");
    },
    ...fake,
  };
}

/** Ports that do nothing: an empty storage slot, events nobody fires, a
 * registry that accepts anything, a git service that refuses. Override the
 * parts a test is about. */
export function inertPorts(over: Partial<GitPorts> = {}): GitPorts {
  return {
    storage: {
      workspace: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
    },
    ui: {
      registerDockTab: () => ({ dispose: () => {} }),
      registerOverlay: () => ({ dispose: () => {} }),
      setOverlayCovers: () => {},
    },
    events: {
      onPaneSelected: () => ({ dispose: () => {} }),
      onWorkspaceClosed: () => ({ dispose: () => {} }),
      onDeckChanged: () => ({ dispose: () => {} }),
    },
    services: {
      git: gitOf(),
      fs: {
        readFile: async (): Promise<never> => {
          throw unfaked("fs.readFile");
        },
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
}
