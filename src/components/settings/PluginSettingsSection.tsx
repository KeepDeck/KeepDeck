import { useEffect, useState } from "react";
import type {
  SettingsField,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";
import { mergeSectionValues } from "@keepdeck/plugin-api";
import { listApplications } from "../../ipc/app";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { getSettings, updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { Combobox } from "../../ui/Combobox";
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
  // Resolved through the CONTRACT's merge — the very values `ctx.settings.read`
  // hands the plugin. Rendering off the raw bag instead is what let the voice
  // model manager show a pick as active for months while the plugin was handed
  // nothing: the field was declared under one key and written under another,
  // and only this surface papered over it.
  const values = mergeSectionValues(section, stored);

  // The write path re-reads the live bag imperatively (not via the hook):
  // two quick edits in one render frame must not clobber each other.
  const write = (key: string, value: unknown) => {
    const plugins = getSettings()?.plugins ?? DEFAULT_SETTINGS.plugins;
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
      {section.fields.map((field) =>
        field.kind === "custom" ? (
          // Built-in tier only: the plugin owns this body outright. It gets the
          // resolved values and the write-through, so custom state persists —
          // and RESOLVES — exactly like a declarative field's.
          <field.Component key={field.key} values={values} write={write} />
        ) : (
          <PluginField
            key={field.key}
            field={field}
            value={values[field.key]}
            onWrite={(value) => write(field.key, value)}
          />
        ),
      )}
    </>
  );
}

/** One host-rendered control. The value arrives already resolved against the
 * field (`mergeSectionValues` applied the default for anything absent or the
 * wrong shape — the settings file is hand-editable), so the type checks below
 * only narrow `unknown`; they are not a second opinion on what is valid. */
function PluginField({
  field,
  value,
  onWrite,
}: {
  /** Declarative kinds only — `custom` renders above, never through here. */
  field: Exclude<SettingsField, { kind: "custom" }>;
  value: unknown;
  onWrite(newValue: unknown): void;
}) {
  switch (field.kind) {
    case "boolean":
      return (
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={typeof value === "boolean" ? value : field.default}
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
            value={typeof value === "string" ? value : field.default}
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
            value={typeof value === "number" ? value : field.default}
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
            value={typeof value === "string" ? value : field.default}
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
            Array.isArray(value) && value.every((item) => typeof item === "string")
              ? value
              : field.default
          }
          onWrite={onWrite}
        />
      );
  }
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
        <ApplicationAdd label={field.label} listed={value} onAdd={add} />
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

/** The application add flow: a fuzzy-search combobox over the INSTALLED
 * applications, scanned host-side across the standard app folders — including
 * `~/Applications`, where per-user installers put things the native dialog
 * never surfaces unprompted. Picking stores the display name — the `open -a`
 * argument. */
function ApplicationAdd({
  label,
  listed,
  onAdd,
}: {
  label: string;
  listed: string[];
  onAdd(app: string): void;
}) {
  const [installed, setInstalled] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let alive = true;
    listApplications()
      .then((apps) => {
        if (alive) setInstalled(apps);
      })
      // A failed scan degrades to Browse…-only; nothing to tell the user.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // What's already listed drops out of the menu — adding it again is a no-op.
  const options = installed.filter((app) => !listed.includes(app));
  return (
    <div className="settings__list-add">
      <Combobox
        className="settings__list-combo"
        options={options}
        value={draft}
        onChange={(next) => {
          // A pick (or a typed exact name) adds immediately and clears the
          // field for the next one; anything else is just the filter text.
          if (options.includes(next)) {
            onAdd(next);
            setDraft("");
          } else {
            setDraft(next);
          }
        }}
        ariaLabel={`Add ${label}`}
        placeholder="Search applications…"
      />
    </div>
  );
}
