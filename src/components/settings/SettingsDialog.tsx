import { useState, type ReactNode } from "react";
import { pluginRegistries } from "../../app/pluginManager";
import { useContributions } from "../../plugins";
import { CloseIcon } from "../../ui/icons";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { PluginSettingsSection } from "./PluginSettingsSection";
import { SETTINGS_SECTIONS } from "./sections";

interface SettingsDialogProps {
  onClose(): void;
}

/**
 * Global settings ([F6]) — an in-app modal (no system windows): a left nav of
 * sections over a panel area. Sections talk to the settings store themselves;
 * controls apply instantly, Done/Esc only dismiss. Static sections come from
 * the `SETTINGS_SECTIONS` registry; plugin-contributed sections (rendered by
 * the host from their declared schema) follow.
 */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  useEscape(onClose);
  const contributed = useContributions(pluginRegistries.settingsSections);
  const sections: { id: string; label: string; body: ReactNode }[] = [
    ...SETTINGS_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      body: <s.Component />,
    })),
    ...contributed.map((c) => ({
      id: `plugin:${c.pluginId}`,
      label: c.entry.label,
      body: <PluginSettingsSection pluginId={c.pluginId} section={c.entry} />,
    })),
  ];
  const [activeId, setActiveId] = useState(sections[0].id);
  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  return (
    <ModalOverlay>
      <div
        className="form settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="settings__head">
          <h2 className="form__title settings__title">Settings</h2>
          <button
            type="button"
            className="settings__close"
            onClick={onClose}
            title="Close settings"
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="settings__body">
          <nav className="settings__nav" aria-label="Settings sections">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings__nav-item${s.id === active.id ? " settings__nav-item--active" : ""}`}
                aria-current={s.id === active.id || undefined}
                onClick={() => setActiveId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          {sections.map((s) => (
            // Every section stays mounted and inactive ones hide (the
            // DeckStage pattern): switching must not remount a panel — a
            // remount refetches the agent catalog and flashes the panel
            // empty, and it would drop an uncommitted draft.
            <div
              key={s.id}
              className="settings__section"
              hidden={s.id !== active.id}
            >
              {s.body}
            </div>
          ))}
        </div>

        <div className="confirm__actions">
          <button type="button" className="form__create" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
