import { DEFAULT_SETTINGS, isSettingsKey } from "./codecs";
import type { Settings } from "./types";

/**
 * The settings DOCUMENT model: what a document holds, and how a chosen value
 * enters one. Changes when the decision model changes — nothing here knows the
 * on-disk format.
 */

export interface SettingsDocument {
  /**
   * Exactly the settings somebody CHOSE — the stored file's usable keys, plus
   * whatever [`withSettings`] has set since. This IS what a save writes, so
   * "which keys land on disk" has one home and no predicate.
   *
   * Absence therefore means "never chosen", which is what lets an improved
   * default reach that user; presence means "chosen", even when the value
   * equals today's default, which is what stops tomorrow's change of default
   * from silently overriding them. Sparse storage without this distinction
   * erased a stored `false`, and it already flipped users once — `defaultAgent`
   * went from `null` to `"claude"`.
   */
  readonly chosen: Readonly<Partial<Settings>>;
  /** Every setting's effective value: the defaults with `chosen` laid over
   * them. DERIVED — [`settingsDocument`] is the only place it is built, so it
   * can never disagree with `chosen`. */
  readonly settings: Readonly<Settings>;
  /** Top-level keys of the stored file this build does not know, kept so a save
   * writes them back verbatim (hand edits, and keys from a newer build). */
  readonly extras: Readonly<Record<string, unknown>>;
}

/** THE document constructor: materializes `settings` from `chosen` so the two
 * are built together or not at all. */
export function settingsDocument(
  chosen: Partial<Settings>,
  extras: Record<string, unknown>,
): SettingsDocument {
  return { chosen, settings: { ...DEFAULT_SETTINGS, ...chosen }, extras };
}

/** The document a first run (or a quarantined file) starts from: no decisions,
 * so a save writes only the version markers. */
export function defaultSettingsDocument(): SettingsDocument {
  return settingsDocument({}, {});
}

/**
 * The document with `patch` applied — the ONE way a chosen value enters a
 * document. Every patched key becomes a decision, because the user picking the
 * value that happens to be today's default is still a decision, and the file is
 * where that decision has to survive a change of default.
 *
 * A key the table does not know is dropped, and so is an explicit `undefined`:
 * `Partial<Settings>` admits `{mcpServer: undefined}`, which would otherwise
 * record a decision whose value `JSON.stringify` then omits — a key at once
 * chosen and erased.
 */
export function withSettings(
  doc: SettingsDocument,
  patch: Partial<Settings>,
): SettingsDocument {
  const chosen: Partial<Settings> = { ...doc.chosen };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !isSettingsKey(key)) continue;
    (chosen as Record<string, unknown>)[key] = value;
  }
  return settingsDocument(chosen, doc.extras);
}

/** The notifications bag with `pluginId` (un)muted — deduplicating, so a
 * repeated mute can't stack the id, and order-stable for everyone else. */
export function withPluginMuted(
  prefs: Settings["notifications"],
  pluginId: string,
  muted: boolean,
): Settings["notifications"] {
  const rest = prefs.mutedPlugins.filter((id) => id !== pluginId);
  return { ...prefs, mutedPlugins: muted ? [...rest, pluginId] : rest };
}
