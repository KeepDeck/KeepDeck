import type { ComponentType } from "react";
import type { Disposable } from "./disposable.ts";

/**
 * Settings contribution. The HOST renders the fields with its own form
 * components and owns the values — plugin code does not run while the user
 * types (the Raycast model). Values live in the host's settings store,
 * namespaced by plugin id.
 */
export interface PluginSettings {
  registerSection(section: SettingsSectionContribution): Disposable;
  /** Current values for this plugin's fields (defaults applied). */
  read(): Promise<Record<string, unknown>>;
  /** Fires after any of this plugin's values change. */
  onChange(cb: (values: Record<string, unknown>) => void): Disposable;
}

export interface SettingsSectionContribution {
  label: string;
  fields: SettingsField[];
}

/** One host-rendered settings control. The vocabulary grows as real plugins
 * need more — never ahead of them. */
export type SettingsField =
  | {
      kind: "string";
      key: string;
      label: string;
      default: string;
      placeholder?: string;
      /** Render obscured; the value is still stored with the rest. */
      secret?: boolean;
    }
  | { kind: "boolean"; key: string; label: string; default: boolean }
  | { kind: "number"; key: string; label: string; default: number }
  | {
      kind: "select";
      key: string;
      label: string;
      default: string;
      options: { value: string; label: string }[];
    }
  | {
      /** A user-managed list of strings (add / remove rows) — e.g. the Run
       * plugin's "Open in" applications. Order is the stored order. */
      kind: "stringList";
      key: string;
      label: string;
      default: string[];
      /** Placeholder for the add-entry input (free-text mode only). */
      placeholder?: string;
      /** Entries come from a host-rendered search over the INSTALLED
       * applications instead of free text; the picked app's display name
       * (the macOS `open -a` argument) enters the list. */
      picker?: "application";
    }
  | {
      /** BUILT-IN TIER ONLY: a plugin-owned React body rendered inside the
       * host settings page — for surfaces the declarative vocabulary can't
       * express (the Voice plugin's model manager with live download
       * progress). A component cannot cross the sandbox boundary, so the
       * external tier rejects this kind at registration. `key` is what the
       * host resolves the stored value under (see `mergeSectionValues`), so it
       * must match the key the component reads and writes — it is NOT merely a
       * React list key. The host hands the component the plugin's persisted
       * settings VALUES and the write-through — custom state lives in the
       * same on-disk bag as every declarative field's. */
      kind: "custom";
      key: string;
      Component: ComponentType<CustomSettingsFieldProps>;
    };

/** What a `custom` settings field's component receives from the host: the
 * plugin's current settings values (defaults NOT applied — absent means
 * unset) and a write that persists one key through the host settings store,
 * feeding `settings.onChange` like any field. */
export interface CustomSettingsFieldProps {
  values: Record<string, unknown>;
  write(key: string, value: unknown): void;
}

/**
 * A plugin's effective settings values: the section's field defaults overlaid
 * with whatever the user stored. Only keys the section DECLARES come through —
 * a stale stored key from a removed field doesn't leak back into the plugin,
 * mirroring how the host renders only declared fields.
 *
 * This IS the contract for how a declaration resolves a stored value, so it
 * lives beside the field vocabulary rather than in the host: the host answers
 * `settings.read` with it, and any test double that answers that call must use
 * the same function or it will serve values the host would drop.
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
    case "custom":
      // A custom (built-in-tier) field's shape is the plugin's own — the host
      // has no type or default to enforce, so pass the stored value through as
      // it went in. Without this the round-trip (`ctx.settings.read`/`onChange`)
      // silently drops every custom field, so a plugin reading its own custom
      // state that way (not just via the render prop) never sees it.
      return stored;
  }
}
