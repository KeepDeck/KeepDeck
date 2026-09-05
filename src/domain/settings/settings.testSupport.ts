import {
  DEFAULT_SETTINGS,
  hydrateSettings,
  type Settings,
  type SettingsDocument,
  type SettingsKey,
  type SettingsProvenance,
} from ".";

/**
 * Shared fixtures for the settings suites. Extracted rather than copied into
 * each file: the per-setting table below is the input every property test
 * drives, and a stale second copy would quietly stop covering a key.
 */

/** The document a stored text restores to — what most cases actually assert on. */
export function restore(json: string): SettingsDocument {
  const hydrated = hydrateSettings(json);
  if (!hydrated) throw new Error(`expected ${json} to hydrate`);
  return hydrated.doc;
}

/** What reading a stored text reported about it. */
export function report(json: string): SettingsProvenance {
  const hydrated = hydrateSettings(json);
  if (!hydrated) throw new Error(`expected ${json} to hydrate`);
  return hydrated.provenance;
}

/**
 * One non-default value per setting. The mapped type is TOTAL, so a new
 * setting cannot be added without giving the property tests something to
 * drive — which is the point: "round-trips losslessly" once exercised two keys
 * out of thirteen, and a key with a wrong or missing reader passed the whole
 * suite while being erased from disk on the next save.
 */
export const NON_DEFAULT: { [K in SettingsKey]: Settings[K] } = {
  defaultAgent: "opencode",
  defaultYolo: true,
  scrollback: 42_000,
  suspendedAgentPlacement: "tray",
  dockMode: "floating",
  plugins: {
    enabled: { "keepdeck.git": true },
    values: { "keepdeck.git": { remote: "origin" } },
    consented: { "acme.tool": "fingerprint" },
  },
  notifications: { enabled: false, mode: "app", mutedPlugins: ["keepdeck.run"] },
  usageDisplay: "left",
  remoteAgents: true,
  parkAgentsOnLaunch: true,
  agentTeams: true,
  artifacts: true,
  artifactAutoOpen: false,
};

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

/**
 * A value no setting can make sense of, per key. The two Record-shaped keys
 * need a value that is not a record at all — an object of nonsense passes their
 * top-level guard and degrades through the ordinary empty-bag path, which
 * proves nothing about rejection.
 */
export function wrongShapeFor(key: SettingsKey): unknown {
  return key === "plugins" || key === "notifications" ? "not a record" : { nope: true };
}
