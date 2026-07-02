import { useEffect, useRef, useState } from "react";
import { hydrateDeck, serializeDeck } from "../domain/persist";
import { loadDeckState, quarantineDeckState, saveDeckState } from "../ipc/state";
import { seedAgentSeq, seedWorkspaceSeq } from "./ids";
import type { Deck } from "./useDeck";

/** Debounce for writes — a burst of reducer updates lands as one save. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Deck persistence ([F7]): restore the saved deck once on boot, then save the
 * live deck (debounced; atomic on the Rust side) on every change. `restoring`
 * gates the first paint so the empty first-run form doesn't flash before the
 * restored deck arrives.
 */
export function usePersistence(deck: Deck): { restoring: boolean } {
  const [restoring, setRestoring] = useState(true);
  // Never save before the restore attempt finished — an early save would
  // overwrite the stored deck with the initial empty state.
  const loadedRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const hydrateRef = useRef(deck.hydrate);
  hydrateRef.current = deck.hydrate;

  useEffect(() => {
    let cancelled = false;
    void loadDeckState()
      .then((json) => {
        if (cancelled || json === null) return;
        const restored = hydrateDeck(json);
        if (!restored) {
          // Unusable document: keep it around as deck.json.bak for inspection.
          void quarantineDeckState().catch(() => {});
          return;
        }
        // Mints first: ids issued after the restore must not collide with
        // restored `pane-N`/`ws-N`.
        seedAgentSeq(restored.nextAgentSeq);
        seedWorkspaceSeq(restored.nextWorkspaceSeq);
        hydrateRef.current(restored.state);
      })
      .catch(() => {}) // unreadable state → start empty
      .finally(() => {
        if (!cancelled) {
          loadedRef.current = true;
          setRestoring(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const serialized = serializeDeck({
    workspaces: deck.workspaces,
    activeId: deck.activeId,
    focusByWs: deck.focusByWs,
    selectByWs: deck.selectByWs,
  });
  const serializedRef = useRef(serialized);
  serializedRef.current = serialized;

  // `restoring` is a dependency on purpose: a change made WHILE the load was
  // still pending is skipped by the gate, and nothing else would re-fire this
  // effect for it — the restoring→false re-render is what picks it up.
  useEffect(() => {
    if (!loadedRef.current || serialized === lastSavedRef.current) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastSavedRef.current = serialized;
      void saveDeckState(serialized).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }, [serialized, restoring]);

  // Best-effort flush of a pending debounce when the window goes away.
  useEffect(() => {
    const flush = () => {
      if (!loadedRef.current || serializedRef.current === lastSavedRef.current)
        return;
      lastSavedRef.current = serializedRef.current;
      void saveDeckState(serializedRef.current).catch(() => {});
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  return { restoring };
}
