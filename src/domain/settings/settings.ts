import type { AgentType } from "../agents";
import { AGENT_TYPES } from "../agents";
import { isRecord } from "../json";

/**
 * Global app settings ([F6]) — schema, serialization and hydration.
 *
 * Like the deck ([F7]), the Rust side stores the JSON as an OPAQUE string
 * (`settings_load`/`settings_save` in src-tauri/src/state.rs) and every bit of
 * schema knowledge lives here. Unlike the deck, the document is a bag of
 * INDEPENDENT facts and is meant to be hand-editable (`settings.json` in
 * `~/.config/keepdeck`), so tolerance is per key, not all-or-nothing:
 *
 * - only unparsable JSON rejects the document (→ quarantine);
 * - a malformed value degrades just its own key to the default;
 * - unknown keys survive a save round-trip (hand edits and keys written by a
 *   newer build are preserved, not stripped);
 * - serialization is sparse — only keys that differ from the default are
 *   written, so a default improved in a later version reaches every user who
 *   never overrode it.
 */

// Revision + compatibility floor live with every other document's in
// domain/migrations; reading stays per-key tolerant — the floor is the
// only gate (a breach quarantines: rare, true breaking changes only).
export { SETTINGS_VERSION } from "../migrations";
import {
  SETTINGS_MIN_READER,
  SETTINGS_VERSION,
  settingsFloorBreach,
} from "../migrations";

export interface Settings {
  /** Agent preselected for new workspaces and panes. Always a concrete
   * agent; if it isn't installed, the pickers snap to the first one that
   * is ([F1]). */
  defaultAgent: AgentType;
  /** Scrollback lines kept per terminal pane. */
  scrollback: number;
  /** Per-plugin persisted settings, keyed by plugin id. The plugin system
   * itself is not a flag — it simply exists (user decision); `enabled` is
   * each plugin's own on/off switch, `values` is what a plugin's
   * host-rendered settings schema writes — opaque to this layer, like a
   * workspace's plugin slot ([`Workspace.plugins`]) — only the two bags'
   * SHAPE is ours. */
  plugins: {
    enabled: Record<string, boolean>;
    values: Record<string, Record<string, unknown>>;
    /** Per-EXTERNAL-plugin consent receipts: the capability fingerprint the
     * user last agreed to (set when enabling). An installed update whose
     * manifest capabilities no longer match falls back to disabled until
     * re-enabled — an escalation can't ride in on a stored enabled=true,
     * even across app restarts. */
    consented: Record<string, string>;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "claude",
  scrollback: 10_000,
  plugins: { enabled: {}, values: {}, consented: {} },
};

/** Scrollback bounds: below ~1k the terminal is useless with verbose agents;
 * above ~200k xterm's buffer memory (per pane, up to 16 panes) bites. */
export const SCROLLBACK_MIN = 1_000;
export const SCROLLBACK_MAX = 200_000;

/** A settings value plus the unknown top-level keys of the stored document,
 * carried so a save can write them back verbatim. */
export interface SettingsDocument {
  settings: Settings;
  extras: Record<string, unknown>;
}

/** The document a first run (or a quarantined file) starts from. */
export function defaultSettingsDocument(): SettingsDocument {
  return { settings: { ...DEFAULT_SETTINGS }, extras: {} };
}

/** `version` plus every key `Settings` owns, plus retired keys we still
 * consume (a retired key riding extras would be rewritten forever). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "version",
  "minVersion",
  "experimentRunPresets",
  ...Object.keys(DEFAULT_SETTINGS),
]);

/** Clamp a raw scrollback to a sane whole number of lines. */
export function clampScrollback(value: number): number {
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(value)));
}

/**
 * Tolerant read of the persisted plugin settings bag: `null` when there's
 * nothing to keep — an absent/malformed field, or one whose sub-parts all
 * degrade to empty — so hydration leaves `settings.plugins` pointing at the
 * shared `DEFAULT_SETTINGS.plugins` object and a later save stays sparse
 * (mirrors how a malformed value elsewhere degrades to its exact default,
 * object identity included, instead of a fresh-but-equal object that would
 * defeat the `!==`-against-default check in `serializeSettings`).
 *
 * Each of `enabled` and `values` degrades independently, and within each, one
 * bad entry never drops its siblings — the file is hand-editable.
 */
function readPlugins(value: unknown): Settings["plugins"] | null {
  if (!isRecord(value)) return null;
  const enabled: Record<string, boolean> = {};
  if (isRecord(value.enabled)) {
    for (const [id, v] of Object.entries(value.enabled)) {
      if (typeof v === "boolean") enabled[id] = v;
    }
  }
  const values: Record<string, Record<string, unknown>> = {};
  if (isRecord(value.values)) {
    for (const [id, v] of Object.entries(value.values)) {
      // The per-plugin values object is opaque past this point — kept
      // verbatim, like a workspace's plugin slot.
      if (isRecord(v)) values[id] = v;
    }
  }
  const consented: Record<string, string> = {};
  if (isRecord(value.consented)) {
    for (const [id, v] of Object.entries(value.consented)) {
      if (typeof v === "string") consented[id] = v;
    }
  }
  if (
    Object.keys(enabled).length === 0 &&
    Object.keys(values).length === 0 &&
    Object.keys(consented).length === 0
  ) {
    return null;
  }
  return { enabled, values, consented };
}


/**
 * Restore settings from stored JSON. Returns `null` only for a document that
 * isn't a JSON object at all — the caller quarantines it and starts from
 * defaults. Anything else yields usable settings: each recognized key is
 * validated on its own and falls back to its default individually. The
 * `version` field is written for future migrations but deliberately not
 * gated on here — with per-key tolerance, reading a newer document extracts
 * whatever this build understands and preserves the rest as extras.
 */
export function hydrateSettings(json: string): SettingsDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  // Above our compatibility floor → quarantine (per-key tolerance covers
  // additive futures; a raised floor means a key CHANGED MEANING, and
  // half-understanding it would be worse than defaults + kept evidence).
  if (settingsFloorBreach(doc) !== null) return null;

  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (AGENT_TYPES.includes(doc.defaultAgent as AgentType)) {
    settings.defaultAgent = doc.defaultAgent as AgentType;
  }
  if (typeof doc.scrollback === "number" && Number.isFinite(doc.scrollback)) {
    settings.scrollback = clampScrollback(doc.scrollback);
  }
  const plugins = readPlugins(doc.plugins);
  // Only replace the default's object reference when there's genuinely
  // something to keep — otherwise `settings.plugins` stays pointing at
  // `DEFAULT_SETTINGS.plugins`, which is what lets serialization's `!==`
  // default check correctly treat an all-empty bag as sparse (unwritten).
  if (plugins) settings.plugins = plugins;
  // Settings v5 graduation: the retired run-presets experiment flag maps onto
  // the Run plugin's enabled toggle so a user's prior state carries across the
  // transition — someone who had the experiment ON keeps Run on (plugins now
  // default OFF, so without this they'd lose it), and an explicit OFF stays
  // off. Only applied while the plugins bag has no say of its own, and the key
  // is consumed (KNOWN_KEYS), never re-written — rewriting it forever would
  // re-apply the mapping after the user later toggles the plugin.
  if (
    typeof doc.experimentRunPresets === "boolean" &&
    settings.plugins.enabled["keepdeck.run"] === undefined
  ) {
    settings.plugins = {
      ...settings.plugins,
      enabled: {
        ...settings.plugins.enabled,
        "keepdeck.run": doc.experimentRunPresets,
      },
    };
  }

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!KNOWN_KEYS.has(key)) extras[key] = value;
  }
  return { settings, extras };
}

/** Serialize for storage: version, preserved extras, then only the settings
 * that differ from their defaults. */
export function serializeSettings(doc: SettingsDocument): string {
  const out: Record<string, unknown> = {
    version: SETTINGS_VERSION,
    minVersion: SETTINGS_MIN_READER,
    ...doc.extras,
  };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (doc.settings[key] !== DEFAULT_SETTINGS[key]) out[key] = doc.settings[key];
  }
  return JSON.stringify(out);
}
