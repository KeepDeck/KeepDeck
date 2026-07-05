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
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "claude",
  scrollback: 10_000,
  experimentRunPresets: false,
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
