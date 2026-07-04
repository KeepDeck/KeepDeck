import {
  defaultSettingsDocument,
  hydrateSettings,
  serializeSettings,
  type Settings,
  type SettingsDocument,
} from "../domain/settings";
import { describeError, log } from "../ipc/log";
import { loadSettings, quarantineSettings, saveSettings } from "../ipc/settings";

/**
 * The owner of the global app settings ([F6]) — one per app, outside React,
 * like `ptyManager`. Boot calls [`initSettings`] once (main.tsx); React reads
 * through the `useSettings` hook (a `useSyncExternalStore` bridge over
 * [`subscribeSettings`]/[`getSettings`]); any code — component, hook or plain
 * module — writes through [`updateSettings`].
 *
 * Why ownership is out of React: settings are app-scoped facts, not view
 * state — non-React code (spawn planning, provisioning) must be able to read
 * them, and their lifetime must not depend on any component's mount.
 */

let doc: SettingsDocument | null = null;
let boot: Promise<void> | null = null;
// In-flight saves are serialized: each new write queues behind the last, so
// an earlier document can never land after a later one.
let chain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function apply(next: SettingsDocument): void {
  doc = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Load `settings.json` once and expose the validated values. An unusable file
 * is quarantined (kept as `.bak` — it's hand-editable, the typo is evidence)
 * and the app starts from defaults. Idempotent: repeated calls share the
 * first load.
 */
export function initSettings(): Promise<void> {
  boot ??= loadSettings()
    .then((json) => {
      if (json === null) {
        apply(defaultSettingsDocument()); // first run
        return;
      }
      const restored = hydrateSettings(json);
      if (!restored) {
        log.error(
          "web:settings",
          "settings unusable → quarantined, using defaults",
        );
        void quarantineSettings().catch((e) =>
          log.error("web:settings", `quarantine itself failed: ${describeError(e)}`),
        );
        apply(defaultSettingsDocument());
        return;
      }
      apply(restored);
    })
    .catch((e) => {
      // Unreadable file → run on defaults; saving may still work later.
      log.warn("web:settings", `settings load failed: ${describeError(e)}`);
      apply(defaultSettingsDocument());
    });
  return boot;
}

/** The live settings, or `null` until the boot load settles — the first
 * paint waits for it (scrollback is read at terminal construction). The
 * returned object is stable between changes (the `useSyncExternalStore`
 * snapshot contract). */
export function getSettings(): Settings | null {
  return doc?.settings ?? null;
}

/** Apply a change and persist it immediately. Settings changes are rare and
 * user-initiated, so there is no debounce; a failed write is logged and the
 * next change retries the whole (sparse) document anyway. Unknown stored
 * keys ride along untouched. No-op before the load settles. */
export function updateSettings(patch: Partial<Settings>): void {
  if (!doc) return;
  const next: SettingsDocument = {
    settings: { ...doc.settings, ...patch },
    extras: doc.extras,
  };
  apply(next);
  const json = serializeSettings(next);
  chain = chain.then(() =>
    saveSettings(json).catch((e) =>
      log.warn("web:settings", `settings save failed: ${describeError(e)}`),
    ),
  );
}

/** Notify on every settings change (the `useSyncExternalStore` contract). */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget the document, the boot and every listener. */
export function resetSettingsManager(): void {
  doc = null;
  boot = null;
  chain = Promise.resolve();
  listeners.clear();
}
