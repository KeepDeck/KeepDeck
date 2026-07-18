import { useEffect } from "react";
import { hydrateUsageCache, serializeUsageCache } from "../domain/usage";
import { log } from "../ipc/log";
import { loadUsageCache, saveUsageCache } from "../ipc/usage";
import {
  getUsageSnapshot,
  setAccountUsage,
  subscribeUsage,
} from "./usageManager";

/** How long account changes coalesce before a cache write. */
export const USAGE_SAVE_DEBOUNCE_MS = 2_000;

/**
 * The snapshot lane: last-known account windows survive restarts, so a
 * cold-started bar shows honestly-aged data instead of nothing until each
 * CLI happens to speak. Hydration goes through `setAccountUsage` —
 * freshest-wins, so a live report landing before the (async) load resolves
 * is never downgraded by the older snapshot. Saves coalesce on a debounce;
 * pane usage deliberately never persists.
 */
export function useUsagePersistence(): void {
  useEffect(() => {
    let disposed = false;
    void loadUsageCache()
      .then((json) => {
        if (disposed || !json) return;
        for (const [provider, account] of hydrateUsageCache(json)) {
          setAccountUsage(provider, account);
        }
      })
      .catch((e) => log.warn("web:usage", `usage cache load failed: ${e}`));

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSaved = getUsageSnapshot().accounts;
    const unsubscribe = subscribeUsage(() => {
      const { accounts } = getUsageSnapshot();
      if (accounts === lastSaved) return; // pane-only change
      lastSaved = accounts;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        saveUsageCache(serializeUsageCache(getUsageSnapshot().accounts)).catch(
          (e) => log.warn("web:usage", `usage cache save failed: ${e}`),
        );
      }, USAGE_SAVE_DEBOUNCE_MS);
    });

    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
