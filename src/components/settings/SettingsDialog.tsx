import { useState, type ReactNode } from "react";
import { pluginHost, pluginRegistries } from "../../app/pluginManager";
import { useContributions, useInstalledPlugins } from "../../plugins";
import { CloseIcon } from "../../ui/icons";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { PluginPage, RescanButton, sectionFor } from "./PluginPage";
import { SETTINGS_SECTIONS } from "./sections";

interface SettingsDialogProps {
  onClose(): void;
}

/**
 * Global settings ([F6]) — an in-app modal (no system windows): a left nav of
 * sections over a panel area. Sections talk to the settings store themselves;
 * controls apply instantly, Done/Esc only dismiss. App sections come from the
 * `SETTINGS_SECTIONS` registry; below them, under the nav's "Plugins" group
 * header (which carries the global Rescan), EVERY installed plugin is its own
 * section — enable toggle, access, restart and its contributed settings in
 * one place. There is deliberately no all-plugins page (user decision).
 */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  useEscape(onClose);
  const installed = useInstalledPlugins(pluginHost);
  const contributed = useContributions(pluginRegistries.settingsSections);
  const appSections: { id: string; label: string; body: ReactNode }[] =
    SETTINGS_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      body: <s.Component />,
    }));
  // One section per installed plugin, cli agents first (they are what the
  // deck runs) — mirroring the old list's grouping as nav order.
  const pluginSections = [...installed]
    .sort(
      (a, b) => rank(a.manifest.category) - rank(b.manifest.category),
    )
    .map((plugin) => ({
      id: `plugin:${plugin.manifest.id}`,
      label: plugin.manifest.name,
      body: (
        <PluginPage
          plugin={plugin}
          section={sectionFor(contributed, plugin.manifest.id)}
        />
      ),
    }));
  const sections = [...appSections, ...pluginSections];
  const [activeId, setActiveId] = useState(sections[0].id);
  // An uninstalled plugin's section can vanish while open — fall back.
  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  const navItem = (s: { id: string; label: string }) => (
    <button
      key={s.id}
      type="button"
      className={`settings__nav-item${s.id === active.id ? " settings__nav-item--active" : ""}`}
      aria-current={s.id === active.id || undefined}
      onClick={() => setActiveId(s.id)}
    >
      {s.label}
    </button>
  );

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
            {appSections.map(navItem)}
            {/* The group header doubles as home for the global Rescan — the
                one plugins action that belongs to no single plugin. */}
            <div className="settings__nav-group">
              <span className="settings__nav-group-label">Plugins</span>
              <RescanButton />
            </div>
            {pluginSections.length === 0 ? (
              <span className="settings__hint settings__nav-empty">
                No plugins installed
              </span>
            ) : (
              pluginSections.map(navItem)
            )}
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

/** Nav order for plugin categories: cli agents first — they are what the
 * deck runs. */
function rank(category: "cli" | "deck"): number {
  return category === "cli" ? 0 : 1;
}
