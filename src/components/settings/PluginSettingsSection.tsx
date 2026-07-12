import { useState } from "react";
import type {
  SettingsField,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";
import { pickApplication } from "../../ipc/dialogs";
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
    case "stringList":
      return (
        <StringListField
          field={field}
          value={
            Array.isArray(stored) &&
            stored.every((item) => typeof item === "string")
              ? stored
              : field.default
          }
          onWrite={onWrite}
        />
      );
  }
}

/** The picked bundle's display name — the `open -a` argument: the basename
 * with a trailing `.app` stripped (`/Applications/Zed.app` → `Zed`). */
export function appNameFromPath(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "";
  return base.endsWith(".app") ? base.slice(0, -".app".length) : base;
}

/** The stringList editor: one row per entry with a remove control, plus an
 * add flow — the OS application picker when the field asks for it, a free
 * input otherwise. Entries are trimmed; blanks and duplicates never enter
 * the list — silently, since both mean "already what you asked for". */
function StringListField({
  field,
  value,
  onWrite,
}: {
  field: Extract<SettingsField, { kind: "stringList" }>;
  value: string[];
  onWrite(value: string[]): void;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const entry = raw.trim();
    if (!entry) return;
    if (!value.includes(entry)) onWrite([...value, entry]);
  };
  const addFromPicker = () => {
    void pickApplication().then((path) => {
      if (path) add(appNameFromPath(path));
    });
  };
  return (
    <div className="settings__field">
      <span className="form__label">{field.label}</span>
      {value.map((entry) => (
        <div key={entry} className="settings__list-row">
          <span className="settings__list-entry">{entry}</span>
          <button
            type="button"
            className="settings__list-remove"
            onClick={() => onWrite(value.filter((v) => v !== entry))}
            title={`Remove ${entry}`}
            aria-label={`Remove ${entry}`}
          >
            ×
          </button>
        </div>
      ))}
      {field.picker === "application" ? (
        <button
          type="button"
          className="settings__list-add-btn settings__list-add-btn--picker"
          onClick={addFromPicker}
        >
          Add application…
        </button>
      ) : (
        <div className="settings__list-add">
          <input
            {...noAutoCorrect}
            className="form__input"
            value={draft}
            placeholder={field.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                add(draft);
                setDraft("");
              }
            }}
            aria-label={`Add ${field.label}`}
          />
          <button
            type="button"
            className="settings__list-add-btn"
            onClick={() => {
              add(draft);
              setDraft("");
            }}
            disabled={!draft.trim()}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
