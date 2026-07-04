import { useEffect, useRef, useState } from "react";
import {
  defaultSettingsDocument,
  hydrateSettings,
  serializeSettings,
  type Settings,
  type SettingsDocument,
} from "../domain/settings";
import { describeError, log } from "../ipc/log";
import { loadSettings, quarantineSettings, saveSettings } from "../ipc/settings";

export interface SettingsStore {
  /** The live settings, or `null` until the boot load settles — the first
   * paint waits for it (scrollback is read at terminal construction). */
  settings: Settings | null;
  /** Apply a change and persist it immediately. Settings changes are rare
   * and user-initiated, so there is no debounce; a failed write is logged
   * and the next change retries the whole (sparse) document anyway. */
  update(patch: Partial<Settings>): void;
}

/**
 * Global app settings ([F6]): load `settings.json` once on boot, expose the
 * validated values, write through on every change. An unusable file is
 * quarantined (kept as `.bak` — it's hand-editable, the typo is evidence)
 * and the app starts from defaults. Unknown keys ride along untouched in
 * the document and are written back verbatim.
 */
export function useSettings(): SettingsStore {
  const [doc, setDoc] = useState<SettingsDocument | null>(null);
  // The ref is the write path's source of truth: updates in the same tick
  // must chain (React state is stale until the next render).
  const docRef = useRef<SettingsDocument | null>(null);
  // In-flight saves are serialized: each new write queues behind the last,
  // so an earlier document can never land after a later one.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const apply = (next: SettingsDocument) => {
      if (cancelled) return;
      docRef.current = next;
      setDoc(next);
    };
    void loadSettings()
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
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    const current = docRef.current;
    if (!current) return; // no writes before the load settled
    const next: SettingsDocument = {
      settings: { ...current.settings, ...patch },
      extras: current.extras,
    };
    docRef.current = next;
    setDoc(next);
    const json = serializeSettings(next);
    chainRef.current = chainRef.current.then(() =>
      saveSettings(json).catch((e) =>
        log.warn("web:settings", `settings save failed: ${describeError(e)}`),
      ),
    );
  };

  return { settings: doc?.settings ?? null, update };
}
