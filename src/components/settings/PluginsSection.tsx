import { useState } from "react";
import type {
  Capability,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";
import { RefreshIcon } from "@keepdeck/ui-kit/icons";
import {
  externalPluginInfo,
  pluginHost,
  pluginRegistries,
  rescanPlugins,
  restartPlugin,
} from "../../app/pluginManager";
import { useContributions, useInstalledPlugins } from "../../plugins";
import type { Contribution } from "../../plugins/registries/contributions";
import { PluginSettingsSection } from "./PluginSettingsSection";

/**
 * The installed plugins — not an experiment, a first-class part of the app
 * (user decision: the system either exists or it doesn't; no master flag).
 * ONE home for everything plugin: each row shows the enable toggle, an
 * external plugin's requested access (enabling IS the consent) and `dev`
 * badge — and, for an active plugin that contributed a settings section, its
 * fields inline right under the row (user decision: no separate nav entries
 * for plugin settings). A disabled plugin's section is unregistered with the
 * plugin, so the fields and the features they toggle appear and disappear
 * together. Rescan re-reads the plugins folder (KeepDeck doesn't watch it);
 * Restart reloads an active plugin.
 */
/** One rescan-spinner turn, in ms — mirrors the 0.7s CSS animation period so
 * the JS hold lands on a full rotation. */
const SPIN_MS = 700;

export function PluginsSection() {
  const installed = useInstalledPlugins(pluginHost);
  const sections = useContributions(pluginRegistries.settingsSections);
  const [scanning, setScanning] = useState(false);

  const rescan = () => {
    if (scanning) return;
    setScanning(true);
    // The spin tracks the scan as a process: it runs for however long the
    // scan takes, but never less than one turn, and is rounded UP to a whole
    // turn so it always covers the work AND stops cleanly at 0° (no mid-turn
    // snap-back). SPIN_MS mirrors the 0.7s CSS animation period.
    const start = Date.now();
    void rescanPlugins().finally(() => {
      const elapsed = Date.now() - start;
      const hold = Math.max(SPIN_MS, Math.ceil(elapsed / SPIN_MS) * SPIN_MS);
      setTimeout(() => setScanning(false), hold - elapsed);
    });
  };

  return (
    <>
      <div className="settings__plugins-head">
        <span className="settings__hint">
          Plugins live in <code>~/.config/keepdeck/plugins</code>.
        </span>
        <button
          type="button"
          className="bar__icon settings__rescan"
          onClick={rescan}
          disabled={scanning}
          title="Rescan the plugins folder"
          aria-label="Rescan plugins"
        >
          {/* The wrapper is ALWAYS inline-flex; only the animation toggles, so
              switching scan state never changes the icon's box (which would
              nudge the whole row). */}
          <span className={`settings__spin${scanning ? " settings__spin--on" : ""}`}>
            <RefreshIcon />
          </span>
        </button>
      </div>

      {installed.length === 0 ? (
        <p className="settings__hint">No plugins installed.</p>
      ) : (
        <div className="settings__plugins">
          {GROUPS.map(({ category, title }) => {
            const members = installed.filter(
              (p) => p.manifest.category === category,
            );
            if (members.length === 0) return null;
            return (
              <div key={category} className="settings__plugin-group">
                <span className="settings__plugin-group-title">{title}</span>
                {members.map((plugin) => (
                  <PluginRow
                    key={plugin.manifest.id}
                    plugin={plugin}
                    section={sectionFor(sections, plugin.manifest.id)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Category grouping, cli agents first — they are what the deck runs. */
const GROUPS: { category: "cli" | "deck"; title: string }[] = [
  { category: "cli", title: "CLI agents" },
  { category: "deck", title: "Deck" },
];

/** The settings section `pluginId` contributed, if any. Registrations live
 * and die with the plugin, so a disabled plugin naturally answers null. Pure
 * — exported for its unit test. */
export function sectionFor(
  contributions: readonly Contribution<SettingsSectionContribution>[],
  pluginId: string,
): SettingsSectionContribution | null {
  return contributions.find((c) => c.pluginId === pluginId)?.entry ?? null;
}

function PluginRow({
  plugin,
  section,
}: {
  plugin: ReturnType<typeof pluginHost.getInstalled>[number];
  section: SettingsSectionContribution | null;
}) {
  const external = externalPluginInfo(plugin.manifest.id);
  return (
    <div className="settings__plugin">
      <div className="settings__plugin-row">
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={plugin.status.kind !== "disabled"}
            onChange={(e) =>
              void pluginHost.setEnabled(plugin.manifest.id, e.target.checked)
            }
            aria-label={`Enable plugin ${plugin.manifest.name}`}
          />
          <span className="settings__toggle-text">
            <span className="settings__plugin-name">
              {plugin.manifest.name}
              {external?.dev && <span className="settings__badge">dev</span>}
            </span>
            <span className="settings__hint">
              {plugin.manifest.id} · {plugin.manifest.version}
              {plugin.status.kind === "failed" &&
                ` · failed: ${plugin.status.reason}`}
            </span>
            {external && plugin.manifest.capabilities.length > 0 && (
              <span className="settings__hint">
                Wants: {plugin.manifest.capabilities.map(describe).join(", ")}
              </span>
            )}
          </span>
        </label>
        {plugin.status.kind === "active" && (
          <button
            type="button"
            className="form__cancel settings__plugin-restart"
            onClick={() => void restartPlugin(plugin.manifest.id)}
            title={`Restart ${plugin.manifest.name}`}
          >
            Restart
          </button>
        )}
      </div>
      {section && plugin.status.kind === "active" && (
        <div className="settings__plugin-fields">
          <PluginSettingsSection
            pluginId={plugin.manifest.id}
            section={section}
          />
        </div>
      )}
    </div>
  );
}

/** A capability in plain words — what the user is consenting to. */
function describe(cap: Capability): string {
  switch (cap.kind) {
    case "exec":
      return `run ${cap.commands.join("/")}`;
    case "fs":
      return cap.scope === "everywhere" ? "read any file" : "read project files";
    case "net":
      return `reach ${cap.domains.join("/")}`;
    case "ports":
      return "allocate ports";
    case "open":
      return "open links & files";
  }
}
