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
      /** Placeholder for the add-entry input. */
      placeholder?: string;
    };
