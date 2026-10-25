import type {
  PluginEvents,
  PluginHostFacts,
  PluginLogger,
  PluginOpener,
  PluginSettings,
  PluginStorage,
} from "@keepdeck/plugin-api";
import type { RunManager } from "./manager";

/**
 * The activation's live wiring, held at module scope. `activate` builds the
 * manager and stashes it here alongside the context; the dock-tab component
 * tree — mounted by the host, not by us, so it can't be handed props — reads
 * both back through `getRuntime()`. Cleared on `deactivate`.
 *
 * Tests set it directly via `setRuntime` with fakes, which is the seam the
 * ported RunTab/RunLog/manager suites drive.
 */
export interface RunRuntime {
  manager: RunManager;
  ctx: RunViewPorts;
}

/** What the tab tree needs from the host — the parts of its context the
 * presets, the "Open in" choice and the log view read. */
export interface RunViewPorts {
  storage: Pick<PluginStorage, "workspace">;
  events: Pick<PluginEvents, "onDeckChanged">;
  settings: Pick<PluginSettings, "read" | "onChange">;
  host: PluginHostFacts;
  services: { opener: PluginOpener };
  log: PluginLogger;
}

let runtime: RunRuntime | null = null;

export function setRuntime(next: RunRuntime | null): void {
  runtime = next;
}

/** The current activation's runtime; throws if read before `activate` (a
 * component rendered without the plugin active is a wiring bug, not a state). */
export function getRuntime(): RunRuntime {
  if (!runtime) {
    throw new Error("Run plugin: runtime read before activate()");
  }
  return runtime;
}

/** The runtime if set, else null — for `deactivate`, where "not active" is a
 * legitimate state (a double teardown), not a bug. */
export function peekRuntime(): RunRuntime | null {
  return runtime;
}
