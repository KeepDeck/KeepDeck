import type { SettingsSectionContribution } from "@keepdeck/plugin-api";

/**
 * The stored keys a section declares no field for — values the host will never
 * hand the plugin, because `mergeSectionValues` builds its answer out of the
 * declared fields alone.
 *
 * This is the shape that hid the voice model pick: the manager wrote and read
 * `model` while the section declared `models`, so the settings page showed the
 * choice (a custom field used to receive the raw bag) while the plugin was
 * handed nothing, every launch, silently.
 *
 * Checked once, when the section is DECLARED — not on the read path, which also
 * serves the change-fingerprint and would repeat this on every settings write.
 * A key the plugin genuinely retired surfaces here too, and that is the same
 * useful signal: the value is dead weight on disk that nothing can consume.
 */
export function undeclaredStoredKeys(
  section: SettingsSectionContribution,
  stored: Record<string, unknown> | undefined,
): string[] {
  const declared = new Set(section.fields.map((field) => field.key));
  return Object.keys(stored ?? {}).filter((key) => !declared.has(key));
}
