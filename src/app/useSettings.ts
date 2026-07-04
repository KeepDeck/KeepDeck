import { useSyncExternalStore } from "react";
import type { Settings } from "../domain/settings";
import { getSettings, subscribeSettings } from "./settingsManager";

/**
 * The live global settings ([F6]), `null` until the boot load settles — a
 * React bridge over the `settingsManager` singleton. Read-only by design:
 * writes go through `updateSettings` directly (it isn't React state).
 */
export function useSettings(): Settings | null {
  return useSyncExternalStore(subscribeSettings, getSettings);
}
