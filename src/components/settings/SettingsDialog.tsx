import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppRuntime } from "../../app/runtimeContext";
import { useContributions, useInstalledPlugins } from "../../plugins";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { PluginPage, RescanButton, sectionFor } from "./PluginPage";
import { SETTINGS_SECTIONS } from "./sections";

interface SettingsDialogProps {
  onClose(): void;
  /** Open on this section instead of the first one — the bar's update chip
   * jumps to Updates, a plugin's `settings.open` command to its own
   * `plugin:<id>` page. Unknown ids fall back to the first section. */
  initialSectionId?: string;
}

/**
 * Global settings ([F6]) — an in-app modal (no system windows): a left nav of
 * sections over a panel area. Sections talk to the settings store themselves;
 * controls apply instantly; the header close/Esc dismiss. App sections come
 * from the `SETTINGS_SECTIONS` registry; below them, under the nav's "Plugins"
 * group header (which carries the global Rescan), EVERY installed plugin is
 * its own section — enable toggle, access, restart and its contributed
 * settings in one place. There is deliberately no all-plugins page (user
 * decision), and no redundant bottom Done footer stealing content space.
 */
export function SettingsDialog({
  onClose,
  initialSectionId,
}: SettingsDialogProps) {
  const { pluginHost, pluginRegistries } = useAppRuntime().plugins;
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
    .sort((a, b) => rank(a.manifest.category) - rank(b.manifest.category))
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
  // Honor a requested section only if it exists — a plugin opening its own
  // page always will, but a stale id degrades to the first section.
  const [activeId, setActiveId] = useState(
    initialSectionId && sections.some((s) => s.id === initialSectionId)
      ? initialSectionId
      : sections[0].id,
  );
  // An uninstalled plugin's section can vanish while open — fall back.
  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  const navRef = useRef<HTMLElement>(null);

  // A command/notification may open Settings directly on a plugin below the
  // nav fold. Keep the selected row visible without stealing entry focus from
  // the dialog's close control; the same path reveals General after an active
  // plugin disappears.
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>("[aria-current]")
      ?.scrollIntoView({ block: "nearest" });
  }, [active.id]);

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
          <CloseButton label="Close settings" onClick={onClose} autoFocus />
        </div>

        <div className="settings__body">
          <nav
            ref={navRef}
            className="settings__nav"
            aria-label="Settings sections"
          >
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

      </div>
    </ModalOverlay>
  );
}

/** Nav order for plugin categories: cli agents first — they are what the
 * deck runs. */
function rank(category: "cli" | "deck"): number {
  return category === "cli" ? 0 : 1;
}
