import type { VoiceController, VoiceSnapshot } from "./controller";
import type { ModelDownloads } from "./downloads";
import type { ModelsStore } from "./models";

/** A controller that is idle and does nothing. Spread the calls a test does
 * fake over it. */
export function controllerOf(
  fake: Partial<VoiceController> = {},
  snap: VoiceSnapshot = {
    phase: "idle",
    mode: null,
    level: 0,
    device: null,
    reading: null,
    readingAt: 0,
    lastHold: null,
    micPick: null,
    history: [],
  },
): VoiceController {
  return {
    snapshot: () => snap,
    subscribe: () => () => {},
    start: async () => {},
    stop: async () => {},
    cancel: async () => {},
    clearHistory: () => {},
    chooseMicrophone: async () => {},
    dispose: async () => {},
    ...fake,
  };
}

/** A models store with nothing read and nothing installed. */
export function modelsOf(fake: Partial<ModelsStore> = {}): ModelsStore {
  return {
    snapshot: () => null,
    current: async () => [],
    subscribe: () => () => {},
    refresh: async () => {},
    error: () => null,
    remove: async () => {},
    removeErrors: () => ({}),
    ...fake,
  };
}

const NO_DOWNLOADS = { active: {}, errors: {}, interrupted: {} };

/** A download manager with nothing in flight. */
export function downloadsOf(fake: Partial<ModelDownloads> = {}): ModelDownloads {
  return {
    snapshot: () => NO_DOWNLOADS,
    subscribe: () => () => {},
    start: async () => true,
    cancel: () => {},
    forget: () => {},
    anyActive: () => false,
    ...fake,
  };
}
