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
 * The usage snapshot lane, booted from `main.tsx` beside `initSettings` —
 * store persistence is boot IO, not a React concern (it consumes nothing
 * reactive; the other usage lanes do and stay hooks). Last-known account
 * windows survive restarts, so a cold-started bar shows honestly-aged data
 * instead of nothing until each CLI happens to speak.
 *
 * Hydration goes through `setAccountUsage` — freshest-wins, so a live
 * report landing before the (async) load resolves is never downgraded by
 * the older snapshot. Saves coalesce on a debounce; pane usage
 * deliberately never persists. Returns the dispose (tests; the app runs it
 * for its lifetime).
 */
export function initUsagePersistence(): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSaved = getUsageSnapshot().accounts;
  // The store emits SYNCHRONOUSLY inside setAccountUsage, so applying the
  // loaded snapshot would trip our own subscriber and echo the cache back
  // at itself every boot — mute it for the application, then re-baseline.
  let hydrating = false;

  void loadUsageCache()
    .then((json) => {
      if (disposed || !json) return;
      hydrating = true;
      try {
        for (const [provider, account] of hydrateUsageCache(json)) {
          setAccountUsage(provider, account);
        }
      } finally {
        hydrating = false;
      }
      lastSaved = getUsageSnapshot().accounts;
    })
    .catch((e) => log.warn("web:usage", `usage cache load failed: ${e}`));

  const unsubscribe = subscribeUsage(() => {
    if (hydrating) return; // what hydration applies IS what's on disk
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
}
