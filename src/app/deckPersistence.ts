import { hydrateDeck, paneIdleIsDurable, serializeDeck } from "../domain/deck";
import { emptyJournal } from "../domain/journal";
import { describeError, log } from "../ipc/log";
import {
  loadDeckState,
  quarantineDeckState,
  saveDeckState,
} from "../ipc/state";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import { seedAgentSeq } from "./ids";
import { initSettings } from "./settingsManager";

const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_WAIT_MS = 2_000;

export interface DeckPersistenceSnapshot {
  restoring: boolean;
  frozen: DeckPark | null;
}

export type DeckPark =
  | { kind: "newer-build"; version: number; minVersion: number }
  | { kind: "unreadable" };

export interface DeckPersistence {
  getSnapshot(): DeckPersistenceSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** App-lifetime owner of deck loading, hydration and ordered durable writes. */
export function createDeckPersistence(deck: DeckStore): DeckPersistence {
  const actions = createDeckActions(deck);
  const listeners = new Set<() => void>();
  let snapshot: DeckPersistenceSnapshot = { restoring: true, frozen: null };
  let loaded = false;
  let frozen = false;
  let disposed = false;
  let lastSaved: string | null = null;
  let lastImmediate: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirtySince: number | null = null;
  let saving = false;
  let docExtras: Record<string, unknown> = {};
  let serialized = serializeSnapshot();
  let immediate = immediateKey();

  function emit(next: DeckPersistenceSnapshot): void {
    if (
      next.restoring === snapshot.restoring &&
      next.frozen === snapshot.frozen
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function serializeSnapshot(): string {
    const state = deck.getSnapshot();
    return serializeDeck(
      {
        workspaces: state.workspaces,
        activeId: state.activeId,
        viewByWs: state.viewByWs,
        journal: emptyJournal,
      },
      docExtras,
    );
  }

  function immediateKey(): string {
    return deck
      .getSnapshot()
      .workspaces.map(
        (workspace) =>
          `${workspace.id}:${workspace.panes
            .map(
              (pane) =>
                `${pane.id}=${pane.session?.id ?? ""}${
                  pane.provisioning ? "+wip" : ""
                }${paneIdleIsDurable(pane.idle) ? "+susp" : ""}`,
            )
            .join(",")}`,
      )
      .join(";");
  }

  function clearTimer(): void {
    if (timer === null) return;
    globalThis.clearTimeout(timer);
    timer = null;
  }

  function retryLater(): void {
    if (disposed || timer !== null) return;
    timer = globalThis.setTimeout(() => {
      timer = null;
      flushNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function flushNow(): void {
    if (disposed || frozen) return;
    clearTimer();
    dirtySince = null;
    if (saving) return;
    const serializedAtStart = serialized;
    const immediateAtStart = immediate;
    saving = true;
    void saveDeckState(serializedAtStart).then(
      () => {
        if (disposed) return;
        lastSaved = serializedAtStart;
        lastImmediate = immediateAtStart;
        saving = false;
        if (serialized !== serializedAtStart) flushNow();
      },
      (error) => {
        if (disposed) return;
        log.warn(
          "web:persist",
          `deck state save failed: ${describeError(error)}`,
        );
        saving = false;
        retryLater();
      },
    );
  }

  function reconcileSave(): void {
    if (!loaded || serialized === lastSaved || frozen || disposed) return;
    if (immediate !== lastImmediate) {
      flushNow();
      return;
    }
    const now = Date.now();
    dirtySince ??= now;
    const deadline = dirtySince + SAVE_MAX_WAIT_MS;
    const delay = Math.min(
      SAVE_DEBOUNCE_MS,
      Math.max(0, deadline - now),
    );
    clearTimer();
    timer = globalThis.setTimeout(flushNow, delay);
  }

  function deckChanged(): void {
    serialized = serializeSnapshot();
    immediate = immediateKey();
    reconcileSave();
  }

  const unsubscribeDeck = deck.subscribe(deckChanged);
  const beforeUnload = () => {
    if (loaded && serialized !== lastSaved) flushNow();
  };
  const browserWindow = typeof window === "undefined" ? null : window;
  browserWindow?.addEventListener("beforeunload", beforeUnload);

  void Promise.all([loadDeckState(), initSettings()])
    .then(([json]) => {
      if (disposed || json === null) return;
      const result = hydrateDeck(json);
      if (result.kind === "incompatible") {
        log.warn(
          "web:persist",
          `deck revision ${result.version} needs a reader ≥ ${result.minVersion} — session parked, saving disabled`,
        );
        frozen = true;
        emit({
          restoring: true,
          frozen: {
            kind: "newer-build",
            version: result.version,
            minVersion: result.minVersion,
          },
        });
        return;
      }
      if (result.kind === "corrupt") {
        log.error(
          "web:persist",
          "deck state unusable → quarantined, starting empty",
        );
        void quarantineDeckState().catch((error) =>
          log.error(
            "web:persist",
            `quarantine itself failed: ${describeError(error)}`,
          ),
        );
        return;
      }
      seedAgentSeq(result.deck.nextAgentSeq);
      docExtras = result.deck.docExtras;
      actions.hydrate(result.deck.state);
    })
    .catch((error) => {
      if (disposed) return;
      log.error(
        "web:persist",
        `deck state load failed → session parked, saving disabled: ${describeError(error)}`,
      );
      frozen = true;
      emit({ restoring: true, frozen: { kind: "unreadable" } });
    })
    .finally(() => {
      if (disposed) return;
      loaded = true;
      deckChanged();
      emit({ restoring: false, frozen: snapshot.frozen });
    });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      unsubscribeDeck();
      browserWindow?.removeEventListener("beforeunload", beforeUnload);
      listeners.clear();
    },
  };
}
