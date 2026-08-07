import {
  defaultSettingsDocument,
  hydrateSettings,
  serializeSettings,
  withSettings,
  type Settings,
  type SettingsDocument,
  type SettingsProvenance,
} from "../domain/settings";
import { describeError, log } from "../ipc/log";
import {
  loadSettings,
  quarantineSettings,
  saveSettings,
  snapshotSettings,
} from "../ipc/settings";

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
 * **The file is never written from a state we did not read.** A load that
 * FAILS leaves the stored document unknown, and a document we invented must
 * not replace one we simply could not see — so such a session runs on defaults
 * and refuses to save, loudly, until a restart can read the file again. The
 * alternative, writing our defaults over it, is the "my settings reset" report
 * itself. A load that answers "no file" is different in kind: `NotFound` is a
 * CONFIRMED absence, so a first run saves normally.
 *
 * Every load, every refusal and every failure is LOGGED. Silence here is what
 * made the original report unanswerable: eleven log files across two weeks
 * contained not one line about settings.
 */

/** What the manager needs from the outside world. Injected so a test builds a
 * fresh manager over fakes instead of resetting a shared one. */
export interface SettingsPorts {
  loadSettings(): Promise<string | null>;
  saveSettings(json: string): Promise<void>;
  quarantineSettings(): Promise<void>;
  snapshotSettings(): Promise<void>;
}

export interface SettingsManager {
  init(): Promise<void>;
  get(): Settings | null;
  update(patch: Partial<Settings>): void;
  subscribe(listener: () => void): () => void;
  /** Resolves once every queued write has landed. */
  flush(): Promise<void>;
  /** Keep a copy of the stored file before something risky (an app update). */
  snapshot(): Promise<void>;
}

/** What reading the stored file established. `unreadable` is the one arm that
 * does NOT license a write: it means the file's contents are still unknown. */
type StoredRead =
  | { kind: "restored"; doc: SettingsDocument; provenance: SettingsProvenance }
  | { kind: "empty"; why: string }
  | { kind: "unreadable"; why: string };

export function createSettingsManager(ports: SettingsPorts): SettingsManager {
  let doc: SettingsDocument | null = null;
  let boot: Promise<void> | null = null;
  // In-flight saves are serialized: each new write queues behind the last, so
  // an earlier document can never land after a later one.
  let chain: Promise<void> = Promise.resolve();
  /** Whether the stored file's contents are known, and so may be replaced. */
  let writable = false;
  const listeners = new Set<() => void>();

  function apply(next: SettingsDocument): void {
    doc = next;
    for (const listener of [...listeners]) listener();
  }

  /**
   * THE read of the stored document: load, retry, interpret, and preserve what
   * cannot be interpreted. One owner, because the alternative — each caller
   * assembling load/hydrate/quarantine itself — already produced a second site
   * that skipped the quarantine and then overwrote the file it had declined to
   * read.
   */
  async function readStoredDocument(): Promise<StoredRead> {
    let json: string | null;
    try {
      json = await ports.loadSettings();
    } catch (first) {
      log.warn(
        "web:settings",
        `settings load failed (${describeError(first)}) — retrying once`,
      );
      // One retry, because the causes that produce a rejected read are usually
      // momentary (a file briefly locked, a home not yet mounted, EMFILE under
      // load) and the price of giving up is a session that cannot save at all.
      try {
        json = await ports.loadSettings();
      } catch (again) {
        return { kind: "unreadable", why: describeError(again) };
      }
    }
    // `null` is `NotFound` and nothing else (see the Rust `load`), so it is a
    // fact about the file, not a failure to learn one.
    if (json === null) return { kind: "empty", why: "no settings file" };
    const restored = hydrateSettings(json);
    if (restored) return { kind: "restored", ...restored };
    // Unusable, and the file is hand-editable, so the typo is evidence: keep it
    // before treating the slot as free. A quarantine that did NOT land leaves
    // the original in place, and writing over it is exactly what must not
    // happen — so that failure downgrades the whole session to read-only.
    try {
      await ports.quarantineSettings();
    } catch (e) {
      return {
        kind: "unreadable",
        why: `unusable, and the quarantine failed: ${describeError(e)}`,
      };
    }
    return { kind: "empty", why: "settings were unusable → quarantined" };
  }

  function describeProvenance(provenance: SettingsProvenance, chosen: number): string {
    const revision = provenance.version ?? "unstamped";
    const dropped =
      provenance.degraded.length > 0
        ? `; discarded and defaulted: ${provenance.degraded.join(", ")}`
        : "";
    return `settings loaded: revision ${revision}, ${chosen} stored key(s)${dropped}`;
  }

  return {
    init(): Promise<void> {
      boot ??= readStoredDocument().then((read) => {
        switch (read.kind) {
          case "restored":
            log.info(
              "web:settings",
              describeProvenance(read.provenance, Object.keys(read.doc.chosen).length),
            );
            writable = true;
            apply(read.doc);
            return;
          case "empty":
            // Not silent even though a first run is legitimate: on a machine
            // that has run before, "no file" is a document that vanished.
            log.warn("web:settings", `${read.why} — starting from defaults`);
            writable = true;
            apply(defaultSettingsDocument());
            return;
          case "unreadable":
            log.error(
              "web:settings",
              `settings could not be read (${read.why}) — running on defaults, and NOT saving this session: overwriting a file we cannot read would destroy it. Restart to try again.`,
            );
            writable = false;
            apply(defaultSettingsDocument());
            return;
        }
      });
      return boot;
    },

    /** The live settings, or `null` until the boot load settles — the first
     * paint waits for it (scrollback is read at terminal construction). The
     * returned object is stable between changes (the `useSyncExternalStore`
     * snapshot contract). */
    get(): Settings | null {
      return doc?.settings ?? null;
    },

    /** Apply a change and persist it immediately. Settings changes are rare and
     * user-initiated, so there is no debounce; a failed write is logged and the
     * next change retries the whole document anyway. Unknown stored keys ride
     * along untouched. No-op before the load settles. */
    update(patch: Partial<Settings>): void {
      if (!doc) return;
      // `withSettings`, not a spread: a patched key is also recorded as chosen,
      // or a value equal to today's default is dropped from the file and a
      // later change of default silently overrides the user.
      apply(withSettings(doc, patch));
      if (!writable) {
        log.error(
          "web:settings",
          "settings change applied in memory but NOT saved — the stored file could not be read at startup; restart to save again",
        );
        return;
      }
      const json = serializeSettings(doc);
      chain = chain
        .then(() => ports.saveSettings(json))
        .catch((e) =>
          // Terminal, on the chain itself: a rejection left unhandled here
          // would make every later `chain.then(...)` skip its callback, and
          // settings would stop persisting for the rest of the session with
          // nothing to show for it.
          log.warn("web:settings", `settings save failed: ${describeError(e)}`),
        );
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    flush(): Promise<void> {
      return chain;
    },

    async snapshot(): Promise<void> {
      // Queued writes land FIRST: a copy taken while a save is still pending
      // would preserve the document the user is replacing rather than the one
      // they actually have.
      await chain;
      await ports.snapshotSettings();
    },
  };
}

/** The app's one settings owner, wired to the real IPC. The named exports
 * below are its bound verbs — the stable surface main.tsx, the runtime, the
 * hooks and every settings surface consume. */
let manager = createSettingsManager({
  loadSettings,
  saveSettings,
  quarantineSettings,
  snapshotSettings,
});

export const initSettings = (): Promise<void> => manager.init();
export const getSettings = (): Settings | null => manager.get();
export const updateSettings = (patch: Partial<Settings>): void =>
  manager.update(patch);
export const subscribeSettings = (listener: () => void): (() => void) =>
  manager.subscribe(listener);
export const flushSettings = (): Promise<void> => manager.flush();
/** Keep a copy of the settings before an app update swaps the bundle. Owned
 * here, not by the update flow: this owner is the only thing that knows a write
 * may still be queued, and a copy taken mid-write preserves the wrong
 * document. */
export const snapshotSettingsForUpdate = (): Promise<void> => manager.snapshot();

/** Replace the process-wide owner with a fresh one. The manager itself holds no
 * shared state to clear — every field lives in the closure above — so this is a
 * one-line swap rather than a hand-kept mirror of the fields to reset, which is
 * the version of this hook that went stale. Tests that can inject ports should
 * build their own manager with {@link createSettingsManager} instead; this
 * exists for the surfaces that reach the singleton through a component. */
export function resetSettingsManager(): void {
  manager = createSettingsManager({
    loadSettings,
    saveSettings,
    quarantineSettings,
    snapshotSettings,
  });
}
