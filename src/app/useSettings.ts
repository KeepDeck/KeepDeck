import { useSyncExternalStore } from "react";
import type { Settings } from "../domain/settings";
import { getSettings, subscribeSettings, updateSettings } from "./settingsManager";

/**
 * The live global settings ([F6]), `null` until the boot load settles — a
 * React bridge over the `settingsManager` singleton. Read-only by design:
 * writes go through `useSettingsWrite` (they aren't React state).
 */
export function useSettings(): Settings | null {
  return useSyncExternalStore(subscribeSettings, getSettings);
}

/** A change to the settings, as a view makes one: the patch is merged in
 * and persisted by the settings manager. */
export type SettingsWrite = (patch: Partial<Settings>) => void;

const write: SettingsWrite = (patch) => updateSettings(patch);

/**
 * The settings write port — the one way a view changes a setting. Stable
 * across renders: a handler may close over it freely.
 */
export function useSettingsWrite(): SettingsWrite {
  return write;
}
