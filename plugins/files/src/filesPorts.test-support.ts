import type { PluginFs } from "@keepdeck/plugin-api";
import type { FilesPorts } from "./runtime";

const unfaked = (what: string) => new Error(`${what}: not faked in this test`);

/** An fs that answers nothing: a call a test did not fake rejects loudly,
 * where an absent method would be a bare "is not a function". Spread the
 * methods a test does fake over it. */
export function fsOf(fake: Partial<PluginFs> = {}): PluginFs {
  return {
    readDir: async (): Promise<never> => {
      throw unfaked("fs.readDir");
    },
    readFile: async (): Promise<never> => {
      throw unfaked("fs.readFile");
    },
    watch: (): never => {
      throw unfaked("fs.watch");
    },
    ...fake,
  };
}

/** Ports that do nothing: a registry that accepts anything, settings that
 * hold nothing, an opener that refuses, an fs that refuses. Override the parts
 * a test is about. */
export function inertPorts(over: Partial<FilesPorts> = {}): FilesPorts {
  return {
    ui: {
      registerDockTab: () => ({ dispose: () => {} }),
      registerOverlay: () => ({ dispose: () => {} }),
      setOverlayCovers: () => {},
    },
    settings: {
      registerSection: () => ({ dispose: () => {} }),
      read: async () => ({}),
      onChange: () => ({ dispose: () => {} }),
    },
    openers: { register: () => ({ dispose: () => {} }) },
    services: {
      fs: fsOf(),
      opener: {
        openUrl: async (): Promise<never> => {
          throw unfaked("opener.openUrl");
        },
        openPath: async (): Promise<never> => {
          throw unfaked("opener.openPath");
        },
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
}
