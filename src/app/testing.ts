/**
 * The app as a view test assembles it — the one door into src/app a
 * component test has besides the hooks and runtimeContext a component
 * itself may use (eslint.config.js). Production imports nothing from here.
 *
 * - The real in-memory parts a test builds and hands in through
 *   AppRuntimeProvider: they are cheap and deterministic, and a typed fake
 *   of each would only drift from the real one.
 * - The seed and reset of the module singletons behind the view ports
 *   (settings, role catalog, updater, the tasks enable status), so a test
 *   starts from a known state and leaves none behind.
 * - The app's test doubles, and stand-ins for the view port hooks.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type Settings } from "../domain/settings";
import type * as UseSettingsModule from "./useSettings";
import type { SettingsWrite } from "./useSettings";

// Runtime parts, built for real.
export { createAgentStatusTracker, type AgentStatusTracker } from "./agentStatusTracker";
export { createUsageManager, type UsageManager } from "./usageManager";
export { createNotificationCenter, type NotificationCenter, type NotifyInput } from "./notificationCenter";
export {
  createSessionIndexManager,
  type SessionIndexManager,
  type SessionIndexSnapshot,
} from "./sessionIndexManager";
export { createTasksService, type TasksService } from "./tasks";
/** The artifacts change signal a registry view re-reads on. */
export { artifactChanges } from "./artifacts/changes";

// Singletons behind the view ports: seed, read back, reset.
export { getSettings, initSettings, resetSettingsManager, updateSettings } from "./settingsManager";
export { initRoleCatalog, resetRoleCatalogManager, saveStoredRole } from "./roleCatalogManager";
export { initUpdates, resetUpdateManager } from "./updateManager";
export { tasksEnableStatus } from "./tasks/enableStatus";
export { armRefusals } from "./armRefusals";

// Doubles.
export { sharedOf } from "./browserShared.test-support";
export { fakeStore, teamedWorkspaces } from "./tasks/testSupport";

/** Where a view test keeps the settings its view reads. */
export interface SettingsStand {
  current: Settings | null;
}

/**
 * `app/useSettings` over `stand`, typed as the module it stands in for —
 * what a view test hands `vi.mock`. The view reads `stand.current`; a write
 * goes to `write` when the test watches writes, else it is merged into the
 * stand and every reader re-renders.
 */
export function settingsHooksOver(stand: SettingsStand, write?: SettingsWrite): typeof UseSettingsModule {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const read = () => stand.current;
  const merge: SettingsWrite = (patch) => {
    stand.current = { ...(stand.current ?? DEFAULT_SETTINGS), ...patch };
    for (const listener of [...listeners]) listener();
  };
  const writer = write ?? merge;
  return {
    useSettings: () => useSyncExternalStore(subscribe, read),
    useSettingsWrite: () => writer,
    useSettingsNow: () => read,
  };
}
