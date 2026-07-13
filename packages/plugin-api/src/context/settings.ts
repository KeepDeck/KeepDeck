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
       * external tier rejects this kind at registration; `key` only keys the
       * React list. The host hands the component the plugin's persisted
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
