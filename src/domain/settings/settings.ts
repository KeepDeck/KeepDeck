import type { AgentType } from "../agents";
import { FALLBACK_AGENTS } from "../agents";

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
  /** Experiment: run presets — launch the app under development in a pane.
   * A flat boolean (not a nested experiments object) so it rides the per-key
   * hydration and sparse serialization unchanged; generalize into a registry
   * only when a few more experiments exist. Read at the UI entry points
   * only — the layers beneath are flag-agnostic. */
  experimentRunPresets: boolean;
  /** Experiment: the plugin system — master switch for its UI surfaces
   * (installed-plugins list, per-plugin settings panels). Flat like its
   * sibling above; the plugins themselves stay registered and their `plugins`
   * bag below stays intact while this is off, so flipping it back on doesn't
   * lose anything. */
  experimentPlugins: boolean;
  /** Per-plugin persisted settings, keyed by plugin id. `enabled` is the
   * per-plugin on/off switch (distinct from `experimentPlugins`, which gates
   * the whole system's UI); `values` is what a plugin's host-rendered
   * settings schema writes — opaque to this layer, like a workspace's plugin
   * slot ([`Workspace.plugins`]) — only the two bags' SHAPE is ours. */
  plugins: {
    enabled: Record<string, boolean>;
    values: Record<string, Record<string, unknown>>;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "claude",
  scrollback: 10_000,
  experimentRunPresets: false,
  experimentPlugins: false,
  plugins: { enabled: {}, values: {} },
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

/** `version` plus every key `Settings` owns — everything else is an extra. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "version",
  "minVersion",
  ...Object.keys(DEFAULT_SETTINGS),
]);

/** The settable agent ids, derived from the one TS catalog (mirrors the
 * derivation in persist.ts — a hand-kept list would silently miss a newly
 * added agent). */
const AGENT_TYPES: readonly AgentType[] = FALLBACK_AGENTS.map((a) => a.id);

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
  if (Object.keys(enabled).length === 0 && Object.keys(values).length === 0) {
    return null;
  }
  return { enabled, values };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (typeof doc.experimentRunPresets === "boolean") {
    settings.experimentRunPresets = doc.experimentRunPresets;
  }
  if (typeof doc.experimentPlugins === "boolean") {
    settings.experimentPlugins = doc.experimentPlugins;
  }
  const plugins = readPlugins(doc.plugins);
  // Only replace the default's object reference when there's genuinely
  // something to keep — otherwise `settings.plugins` stays pointing at
  // `DEFAULT_SETTINGS.plugins`, which is what lets serialization's `!==`
  // default check correctly treat an all-empty bag as sparse (unwritten).
  if (plugins) settings.plugins = plugins;

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
