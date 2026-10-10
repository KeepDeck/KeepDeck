import { DEFAULT_SETTINGS } from "../domain/settings";
import { getSettings, updateSettings } from "./settingsManager";

/**
 * Persist one value in a plugin's settings bag
 * (`settings.plugins.values[pluginId][key]`) — the ONE write both the
 * settings page and a plugin's own `ctx.settings.write` go through.
 *
 * Re-reads the live bag imperatively: two quick writes in one frame must not
 * clobber each other.
 */
export function writePluginValue(pluginId: string, key: string, value: unknown): void {
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
}
