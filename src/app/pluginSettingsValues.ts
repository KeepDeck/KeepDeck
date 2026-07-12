import type {
  SettingsField,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";

/**
 * A plugin's effective settings values: the section's field defaults overlaid
 * with whatever the user stored (`settings.plugins.values[pluginId]`). Only
 * keys the section DECLARES come through — a stale stored key from a removed
 * field doesn't leak back into the plugin, mirroring how the host renders
 * only declared fields.
 */
export function mergeSectionValues(
  section: SettingsSectionContribution | undefined,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!section) return {};
  const values: Record<string, unknown> = {};
  for (const field of section.fields) {
    values[field.key] = pick(field, stored?.[field.key]);
  }
  return values;
}

/** The stored value when it matches the field's type; the default when it is
 * absent or the wrong shape (the settings file is hand-editable). */
function pick(field: SettingsField, stored: unknown): unknown {
  switch (field.kind) {
    case "string":
      return typeof stored === "string" ? stored : field.default;
    case "boolean":
      return typeof stored === "boolean" ? stored : field.default;
    case "number":
      return typeof stored === "number" && Number.isFinite(stored)
        ? stored
        : field.default;
    case "select":
      return typeof stored === "string" &&
        field.options.some((o) => o.value === stored)
        ? stored
        : field.default;
    case "stringList":
      return Array.isArray(stored) &&
        stored.every((item) => typeof item === "string")
        ? stored
        : field.default;
  }
}
