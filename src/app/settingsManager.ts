import {
  defaultSettingsDocument,
  hydrateSettings,
  reconcileProvisional,
  serializeSettings,
  settingsProvenance,
  withSettings,
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
 *
 * Every load and every failure is LOGGED. A settings document that quietly
 * became defaults is indistinguishable from a first run, and that silence is
 * what turns "my settings reset after the update" into an unanswerable report:
 * eleven log files across two weeks contained not one line about settings.
 */

let doc: SettingsDocument | null = null;
let boot: Promise<void> | null = null;
// In-flight saves are serialized: each new write queues behind the last, so
// an earlier document can never land after a later one.
let chain: Promise<void> = Promise.resolve();
/** True while the live document is only a STAND-IN — the file was missing or
 * unreadable, so these values were never anybody's choice. Such a document
 * must not be allowed to overwrite a file that turns out to exist. */
let provisional = false;
const listeners = new Set<() => void>();

function apply(next: SettingsDocument): void {
  doc = next;
  for (const listener of [...listeners]) listener();
}

/** Adopt a document the app invented because it could not read one. */
function applyProvisional(next: SettingsDocument): void {
  provisional = true;
  apply(next);
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
        // Not silent, even though it is the legitimate first-run path: on a
        // machine that has run before, "no file" is a document that vanished,
        // and the stand-in below is what would otherwise overwrite it.
        log.warn("web:settings", "no settings file — starting from defaults");
        applyProvisional(defaultSettingsDocument());
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
        // Provisional as well: if the quarantine did not land, the unusable
        // file is still there, and the re-read before the first save is what
        // stops us writing over it blind.
        applyProvisional(defaultSettingsDocument());
        return;
      }
      const { version, degraded } = settingsProvenance(json);
      log.info(
        "web:settings",
        `settings loaded: revision ${version ?? "unstamped"}, ${restored.explicit.size} stored key(s)` +
          (degraded.length > 0
            ? `; fell back to default: ${degraded.join(", ")}`
            : ""),
      );
      apply(restored);
    })
    .catch((e) => {
      // Unreadable file → run on defaults; saving may still work later.
      log.warn("web:settings", `settings load failed: ${describeError(e)}`);
      applyProvisional(defaultSettingsDocument());
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
  // `withSettings`, not a spread: a patched key must also be recorded as
  // explicitly chosen, or a value equal to today's default is dropped from the
  // file and a later change of default silently overrides the user.
  apply(withSettings(doc, patch));
  chain = chain.then(async () => {
    // Serialized HERE rather than at patch time: a stand-in document may still
    // have to adopt a file that appeared since, and the write must carry the
    // result of that. Queued writes therefore collapse onto the latest state —
    // which is what a bag of current facts wants, and it keeps the ordering
    // guarantee this chain exists for.
    if (provisional) await adoptStoredFile();
    const live = doc;
    if (!live) return;
    await saveSettings(serializeSettings(live)).catch((e) =>
      log.warn("web:settings", `settings save failed: ${describeError(e)}`),
    );
  });
}

/**
 * Look again before letting a stand-in document become the file.
 *
 * If a readable settings.json has turned up since boot, the user's stored
 * values win for everything this session did not explicitly set — so one
 * transient failed or empty load can no longer end with the whole file
 * replaced by defaults. Exactly one attempt: the flag is cleared up front, so
 * a failure here does not re-read on every subsequent save.
 */
async function adoptStoredFile(): Promise<void> {
  provisional = false;
  const mine = doc;
  if (!mine) return;
  let json: string | null;
  try {
    json = await loadSettings();
  } catch (e) {
    log.warn(
      "web:settings",
      `re-read before the first save failed: ${describeError(e)}`,
    );
    return;
  }
  if (json === null) return; // still no file: the stand-in is the truth
  const stored = hydrateSettings(json);
  if (!stored) return; // unusable: already quarantined, ours stands
  log.warn(
    "web:settings",
    "a readable settings file appeared after boot — merging into it instead of overwriting",
  );
  apply(reconcileProvisional(stored, mine));
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
  provisional = false;
  listeners.clear();
}
