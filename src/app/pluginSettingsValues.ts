import {
  mergeSectionValues,
  type SettingsSectionContribution,
} from "@keepdeck/plugin-api";

/**
 * A plugin's effective settings values, with a diagnostic for the one answer
 * the merge cannot distinguish: values ARE on disk, but the plugin has not
 * declared its section yet, so every one of them is dropped and the plugin is
 * handed `{}` — the same answer a first run gives.
 *
 * That silence is what let the voice plugin seed its push-to-talk chords from
 * an empty bag and run every launch on the shipped defaults while the user's
 * sat in settings.json. A plugin reading at construction time cannot tell the
 * two apart, so the host says so in the plugin's own log instead.
 *
 * Deliberately NOT warned: a stored key that no CURRENT field declares. That
 * is the documented, intended drop (a removed field's leftovers must not leak
 * back), so warning on it would be noise on a legitimate case.
 */
export function readDeclaredValues(
  section: SettingsSectionContribution | undefined,
  stored: Record<string, unknown> | undefined,
  warn: (message: string) => void,
): Record<string, unknown> {
  const dropped = section ? 0 : Object.keys(stored ?? {}).length;
  if (dropped > 0) {
    warn(
      `settings read before the section was registered — ${dropped} stored ` +
        "value(s) dropped; register the section first, then read",
    );
  }
  return mergeSectionValues(section, stored);
}
