import type {
  SettingsField,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";
import { getSettings, updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { Dropdown } from "../../ui/Dropdown";
import { noAutoCorrect } from "../../ui/inputProps";

/**
 * A plugin's settings page, rendered BY THE HOST from the declared field
 * schema — plugin code never runs while the user types (the Raycast model).
 * Values live under `settings.plugins.values[pluginId]`; each control writes
 * through the shared settings store, so persistence and the plugin's
 * `onChange` feed come for free.
 */
export function PluginSettingsSection({
  pluginId,
  section,
}: {
  pluginId: string;
  section: SettingsSectionContribution;
}) {
  const stored = useSettings()?.plugins.values[pluginId] ?? {};

  // The write path re-reads the live bag imperatively (not via the hook):
  // two quick edits in one render frame must not clobber each other.
  const write = (key: string, value: unknown) => {
    const plugins = getSettings()?.plugins ?? { enabled: {}, values: {}, consented: {} };
    updateSettings({
      plugins: {
        ...plugins,
        values: {
          ...plugins.values,
          [pluginId]: { ...plugins.values[pluginId], [key]: value },
        },
      },
    });
  };

  return (
    <>
      {section.fields.map((field) => (
        <PluginField
          key={field.key}
          field={field}
          stored={stored[field.key]}
          onWrite={(value) => write(field.key, value)}
        />
      ))}
    </>
  );
}

/** One host-rendered control; a stored value of the wrong shape falls back
 * to the field's default (the settings file is hand-editable). */
function PluginField({
  field,
  stored,
  onWrite,
}: {
  field: SettingsField;
  stored: unknown;
  onWrite(value: unknown): void;
}) {
  switch (field.kind) {
    case "boolean":
      return (
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={typeof stored === "boolean" ? stored : field.default}
            onChange={(e) => onWrite(e.target.checked)}
            aria-label={field.label}
          />
          <span className="settings__toggle-text">{field.label}</span>
        </label>
      );
    case "string":
      return (
        <label className="settings__field">
          <span className="form__label">{field.label}</span>
          <input
            {...noAutoCorrect}
            className="form__input"
            type={field.secret ? "password" : "text"}
            value={typeof stored === "string" ? stored : field.default}
            placeholder={field.placeholder}
            onChange={(e) => onWrite(e.target.value)}
            aria-label={field.label}
          />
        </label>
      );
    case "number":
      return (
        <label className="settings__field">
          <span className="form__label">{field.label}</span>
          <input
            className="form__input"
            type="number"
            value={typeof stored === "number" ? stored : field.default}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (Number.isFinite(parsed)) onWrite(parsed);
            }}
            aria-label={field.label}
          />
        </label>
      );
    case "select":
      return (
        <label className="settings__field">
          <span className="form__label">{field.label}</span>
          <Dropdown
            options={field.options}
            value={typeof stored === "string" ? stored : field.default}
            onChange={onWrite}
            ariaLabel={field.label}
          />
        </label>
      );
  }
}
