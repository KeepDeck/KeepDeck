import { useState } from "react";
import type {
  Capability,
  SettingsSectionContribution,
} from "@keepdeck/plugin-api";
import { RefreshIcon } from "@keepdeck/ui-kit/icons";
import {
  externalPluginInfo,
  pluginHost,
  rescanPlugins,
  restartPlugin,
} from "../../app/pluginManager";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import type { Contribution } from "../../plugins/registries/contributions";
import { PluginSettingsSection } from "./PluginSettingsSection";

/**
 * ONE plugin's settings page — each installed plugin is its own nav section
 * (user decision: no common all-plugins list, no inlining under rows). The
 * page carries everything about the plugin: the enable toggle (for an
 * external plugin enabling IS the consent, so its requested access is spelled
 * out), the `dev` badge, Restart — and, when the plugin is active and
 * contributed a settings section, its fields below a separator. A disabled
 * plugin's section is unregistered with it, so the fields and the features
 * they toggle appear and disappear together.
 */
export function PluginPage({
  plugin,
  section,
}: {
  plugin: ReturnType<typeof pluginHost.getInstalled>[number];
  section: SettingsSectionContribution | null;
}) {
  const external = externalPluginInfo(plugin.manifest.id);
  const notificationPrefs =
    useSettings()?.notifications ?? DEFAULT_SETTINGS.notifications;
  const canNotify = plugin.manifest.capabilities.some(
    (cap) => cap.kind === "notifications",
  );
  const muted = notificationPrefs.mutedPlugins.includes(plugin.manifest.id);
  return (
    <>
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
              {plugin.manifest.experimental && (
                <span className="settings__badge settings__badge--experimental">
                  experimental
                </span>
              )}
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

      {plugin.manifest.description && (
        <p className="settings__hint settings__plugin-about">
          {plugin.manifest.description}
        </p>
      )}

      {canNotify && plugin.status.kind !== "disabled" && (
        // Mute this one plugin's notifications without disabling the plugin —
        // the flip side of the `notifications` capability it declared.
        <div className="settings__plugin-row">
          <label className="settings__toggle">
            <input
              type="checkbox"
              checked={!muted}
              onChange={(e) => {
                const rest = notificationPrefs.mutedPlugins.filter(
                  (id) => id !== plugin.manifest.id,
                );
                updateSettings({
                  notifications: {
                    ...notificationPrefs,
                    mutedPlugins: e.target.checked
                      ? rest
                      : [...rest, plugin.manifest.id],
                  },
                });
              }}
              aria-label={`Allow notifications from ${plugin.manifest.name}`}
            />
            <span className="settings__toggle-text">
              <span>Notifications</span>
              <span className="settings__hint">
                {muted
                  ? "Muted — the plugin runs, its notifications are dropped."
                  : "The plugin may post to the notification center."}
              </span>
            </span>
          </label>
        </div>
      )}

      {section && plugin.status.kind === "active" && (
        <div className="settings__plugin-fields">
          <PluginSettingsSection
            pluginId={plugin.manifest.id}
            section={section}
          />
        </div>
      )}
    </>
  );
}

/** The settings section `pluginId` contributed, if any. Registrations live
 * and die with the plugin, so a disabled plugin naturally answers null. Pure
 * — exported for its unit test. */
export function sectionFor(
  contributions: readonly Contribution<SettingsSectionContribution>[],
  pluginId: string,
): SettingsSectionContribution | null {
  return contributions.find((c) => c.pluginId === pluginId)?.entry ?? null;
}

/** One rescan-spinner turn, in ms — mirrors the 0.7s CSS animation period so
 * the JS hold lands on a full rotation. */
const SPIN_MS = 700;

/** The global "re-read the plugins folder" action — lives on the nav's
 * Plugins group header now that there is no all-plugins page. */
export function RescanButton() {
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
    <button
      type="button"
      className="bar__icon settings__rescan"
      onClick={rescan}
      disabled={scanning}
      title="Rescan the plugins folder (~/.config/keepdeck/plugins)"
      aria-label="Rescan plugins"
    >
      {/* The wrapper is ALWAYS inline-flex; only the animation toggles, so
          switching scan state never changes the icon's box (which would
          nudge the whole row). */}
      <span className={`settings__spin${scanning ? " settings__spin--on" : ""}`}>
        <RefreshIcon />
      </span>
    </button>
  );
}

/** A capability in plain words — what the user is consenting to. */
function describe(cap: Capability): string {
  switch (cap.kind) {
    case "exec":
      return `run ${cap.commands.join("/")}`;
    case "fs":
      return cap.scope === "everywhere" ? "read any file" : "read project files";
    case "git":
      return cap.scope === "everywhere"
        ? "read git state of any repository"
        : "read git state of project repositories";
    case "net":
      return `reach ${cap.domains.join("/")}`;
    case "ports":
      return "allocate ports";
    case "open":
      return "open links & files";
    case "commands":
      return `drive the deck (${cap.execute.join(", ")})`;
    case "mic":
      return "use the microphone (local speech-to-text)";
    case "notifications":
      return "send notifications";
  }
}
