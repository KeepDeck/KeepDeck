import { useEffect, useRef, useState } from "react";
import { hydrateDeck, serializeDeck } from "../domain/persist";
import { describeError, log } from "../ipc/log";
import { loadDeckState, quarantineDeckState, saveDeckState } from "../ipc/state";
import { seedAgentSeq, seedWorkspaceSeq } from "./ids";
import type { Deck } from "./useDeck";

/** Debounce for cosmetic churn (titles, selection) — a burst lands as one
 * save. */
const SAVE_DEBOUNCE_MS = 500;

/** Churn may defer a save at most this long. Busy agent TUIs retitle
 * themselves continuously (<500 ms apart), which starved a plain debounce
 * forever — quitting then lost every deferred change (the codex-pane bug). */
const SAVE_MAX_WAIT_MS = 2_000;

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
          log.error("web:persist", "deck state unusable → quarantined, starting empty");
          void quarantineDeckState().catch((e) =>
            log.error("web:persist", `quarantine itself failed: ${describeError(e)}`),
          );
          return;
        }
        // Mints first: ids issued after the restore must not collide with
        // restored `pane-N`/`ws-N`.
        seedAgentSeq(restored.nextAgentSeq);
        seedWorkspaceSeq(restored.nextWorkspaceSeq);
        hydrateRef.current(restored.state);
      })
      .catch((e) =>
        // Unreadable state → start empty.
        log.warn("web:persist", `deck state load failed: ${describeError(e)}`),
      )
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

  // What a quit must never lose: the deck's SHAPE (which workspaces/panes
  // exist), each pane's session binding AND its provisioning transition.
  // These save immediately, never debounced — a just-added pane or a fresh
  // binding lost on quit is data loss (a wiped binding resumes someone
  // else's conversation; a resolved worktree saved as still-creating would
  // restore as an interrupted card whose Retry mints a -2 sibling), ⌘Q is a
  // native menu role that never reaches the webview, and `beforeunload` is
  // not reliable in Tauri as a safety net.
  const immediate = deck.workspaces
    .map(
      (w) =>
        `${w.id}:${w.panes
          .map(
            (p) =>
              `${p.id}=${p.session?.id ?? ""}${p.provisioning ? "+wip" : ""}`,
          )
          .join(",")}`,
    )
    .join(";");
  const immediateRef = useRef(immediate);
  immediateRef.current = immediate;
  const lastImmediateRef = useRef<string | null>(null);
  // When the oldest still-unsaved change happened — the maxWait anchor.
  const dirtySinceRef = useRef<number | null>(null);

  // An IPC save in flight — its settle handlers re-check for anything newer,
  // so concurrent flushes never overlap (and never resolve out of order).
  const savingRef = useRef(false);

  const flushNow = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    dirtySinceRef.current = null;
    if (savingRef.current) return;
    const snapshot = serializedRef.current;
    const immediateSnapshot = immediateRef.current;
    savingRef.current = true;
    saveDeckState(snapshot).then(
      () => {
        // Only a CONFIRMED write advances the refs — advancing up front
        // would mark a failed save as done, and the effect's guard would
        // suppress every retry (silent loss of the last pre-quit change).
        lastSavedRef.current = snapshot;
        lastImmediateRef.current = immediateSnapshot;
        savingRef.current = false;
        // The deck moved on during the round-trip → save the newer state.
        if (serializedRef.current !== snapshot) flushRef.current();
      },
      (e) => {
        // A failing save is silent data-loss risk — every failure is signal.
        log.warn("web:persist", `deck state save failed: ${describeError(e)}`);
        savingRef.current = false;
        // Refs untouched: the state is still dirty. Retry on a delay so a
        // persistently failing disk doesn't spin a hot save loop.
        if (timerRef.current === null) {
          timerRef.current = window.setTimeout(
            () => flushRef.current(),
            SAVE_DEBOUNCE_MS,
          );
        }
      },
    );
  };
  const flushRef = useRef(flushNow);
  flushRef.current = flushNow;

  // `restoring` is a dependency on purpose: a change made WHILE the load was
  // still pending is skipped by the gate, and nothing else would re-fire this
  // effect for it — the restoring→false re-render is what picks it up.
  useEffect(() => {
    if (!loadedRef.current || serialized === lastSavedRef.current) return;

    // A pane/workspace appeared or vanished, or a session was (re)bound →
    // save NOW.
    if (immediate !== lastImmediateRef.current) {
      flushRef.current();
      return;
    }

    // Cosmetic churn (titles, selection): debounce, but never past
    // SAVE_MAX_WAIT_MS after the first deferred change — continuous churn
    // must converge to a save, not starve it.
    const now = Date.now();
    dirtySinceRef.current ??= now;
    const deadline = dirtySinceRef.current + SAVE_MAX_WAIT_MS;
    const delay = Math.min(SAVE_DEBOUNCE_MS, Math.max(0, deadline - now));
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => flushRef.current(), delay);
  }, [serialized, immediate, restoring]);

  // Best-effort flush of a pending debounce when the window goes away.
  useEffect(() => {
    const flush = () => {
      if (!loadedRef.current || serializedRef.current === lastSavedRef.current)
        return;
      flushRef.current();
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  return { restoring };
}
