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
 * - The app's test doubles.
 */

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

// Doubles.
export { sharedOf } from "./browserShared.test-support";
export { fakeStore, teamedWorkspaces } from "./tasks/testSupport";
