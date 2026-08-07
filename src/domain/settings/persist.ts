import { collectExtras, isRecord } from "../json";
import {
  SETTINGS_MIN_READER,
  SETTINGS_VERSION,
  settingsFloorBreach,
} from "../migrations";
import { settingsCodecs } from "./codecs";
import { settingsDocument, type SettingsDocument } from "./document";
import type { Settings } from "./types";

/**
 * The settings WIRE FORMAT: how a document becomes `settings.json` and back.
 * Changes when the file format does.
 *
 * The Rust side stores the JSON as an OPAQUE string (`settings_load` /
 * `settings_save` in src-tauri/src/state.rs), so every bit of schema knowledge
 * lives here. Unlike the deck, the document is a bag of INDEPENDENT facts and is
 * meant to be hand-editable, so tolerance is per key, not all-or-nothing:
 *
 * - only unparsable JSON (or a floor above this build) rejects the document,
 *   and the caller then quarantines it;
 * - a malformed value degrades just its own key to the default, and says so;
 * - unknown keys survive a save round-trip untouched;
 * - a save writes exactly the DECISIONS the document holds, so absence on disk
 *   means "never chosen" and nothing else (revision 15 — see the ledger).
 */

/** `version` plus every key `Settings` owns, plus retired keys we still consume
 * (a retired key riding extras would be rewritten forever). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "version",
  "minVersion",
  "experimentRunPresets",
  ...settingsCodecs().map(([key]) => key),
]);

/**
 * What a load learned about the stored text, beyond the values it yielded.
 * Returned WITH the document, never carried on it: it describes the FILE, and a
 * document stops corresponding to its file the moment `withSettings` touches it.
 * Computed by the read itself rather than by a second pass, so it cannot drift
 * from what the read actually did.
 */
export interface SettingsProvenance {
  /** The document's own revision, or `null` when it declares none. */
  version: number | null;
  /** What the file carried and the read could not use — a key, or a path inside
   * one (`"plugins.enabled.foo"`). Each fell back to its default. */
  degraded: string[];
}

/** A stored document, restored: the values, and what reading them discarded. */
export interface HydratedSettings {
  doc: SettingsDocument;
  provenance: SettingsProvenance;
}

/**
 * Restore settings from stored JSON. Returns `null` only for a document that
 * isn't a JSON object at all, or one whose compatibility floor is above this
 * build — the caller quarantines it and starts from defaults. Anything else
 * yields usable settings: each recognized key is validated on its own and falls
 * back to its default individually.
 */
export function hydrateSettings(json: string): HydratedSettings | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const doc = raw;
  // Above our compatibility floor → quarantine (per-key tolerance covers
  // additive futures; a raised floor means a key CHANGED MEANING, and
  // half-understanding it would be worse than defaults + kept evidence).
  if (settingsFloorBreach(doc) !== null) return null;

  const degraded: string[] = [];
  const discard = (path: string) => degraded.push(path);
  const chosen: Partial<Settings> = {};
  for (const [key, codec] of settingsCodecs()) {
    // `in` rather than an undefined check: JSON cannot carry `undefined`, so
    // presence is exactly "the file said something about this key" — which is
    // what separates an absent key from one whose value we had to discard.
    if (!(key in doc)) continue;
    const value = codec.read(doc[key], discard);
    if (value === undefined) {
      degraded.push(key);
      continue;
    }
    (chosen as Record<string, unknown>)[key] = value;
  }
  graduateRunPresets(doc, chosen);

  return {
    doc: settingsDocument(chosen, collectExtras(doc, KNOWN_KEYS)),
    provenance: {
      version: typeof doc.version === "number" ? doc.version : null,
      degraded,
    },
  };
}

/**
 * Settings v5 graduation: the retired run-presets experiment flag maps onto the
 * Run plugin's enabled toggle so a user's prior state carries across the
 * transition — someone who had the experiment ON keeps Run on (plugins default
 * OFF, so without this they'd lose it), and an explicit OFF stays off.
 *
 * Applied only while the plugins bag has no say of its own, and the retired key
 * is consumed (it is in `KNOWN_KEYS`), never re-written — rewriting it forever
 * would re-apply the mapping after the user later toggles the plugin. The result
 * is a CHOICE, so it enters `chosen`: relying on it merely differing from the
 * default would lose the Run plugin the moment that fallback is tidied away.
 */
function graduateRunPresets(
  doc: Record<string, unknown>,
  chosen: Partial<Settings>,
): void {
  if (typeof doc.experimentRunPresets !== "boolean") return;
  const bag = chosen.plugins;
  if (bag?.enabled["keepdeck.run"] !== undefined) return;
  chosen.plugins = {
    enabled: { ...bag?.enabled, "keepdeck.run": doc.experimentRunPresets },
    values: { ...bag?.values },
    consented: { ...bag?.consented },
  };
}

/** Serialize for storage: the version markers, the preserved extras, then
 * exactly the settings this document says were chosen — in table order, so a
 * saved file's key order is stable across builds and hand edits. */
export function serializeSettings(doc: SettingsDocument): string {
  const out: Record<string, unknown> = {
    version: SETTINGS_VERSION,
    minVersion: SETTINGS_MIN_READER,
    ...doc.extras,
  };
  for (const [key] of settingsCodecs()) {
    if (key in doc.chosen) out[key] = doc.chosen[key];
  }
  return JSON.stringify(out);
}
