import { deckImmediateKey, hydrateDeck, serializeDeck } from "../domain/deck";
import { emptyJournal } from "../domain/journal";
import type { DeckLoad } from "../domain/lifecycle";
import { log } from "../ipc/log";
import {
  loadDeckState,
  quarantineDeckState,
  saveDeckState,
} from "../ipc/state";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import { initSettings } from "./settingsManager";
import { errorMessage } from "@keepdeck/plugin-api";

const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_WAIT_MS = 2_000;

export interface DeckPersistenceSnapshot {
  restoring: boolean;
  frozen: DeckPark | null;
  /** How the deck loaded; null while it is still loading. With the deck as
   * hydrated, this is the boot snapshot the lifecycle's handshake reads. */
  load: DeckLoad | null;
}

export type DeckPark =
  | { kind: "newer-build"; version: number; minVersion: number }
  | { kind: "unreadable" };

export interface DeckPersistence {
  getSnapshot(): DeckPersistenceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Whether this copy may write deck.json now. A second KeepDeck on the
   * settings folder only shows, and Rust refuses its writes: while it may
   * not, nothing is attempted; once it may, what changed meanwhile is
   * saved. */
  mayWrite(may: boolean): void;
  dispose(): void;
}

/** App-lifetime owner of deck loading, hydration and ordered durable writes.
 *
 * `onNotices` hears what the migration ladder did to the file that the
 * person should know about — once, on the launch that did it: hydration
 * hands the notices over and never writes them back. `onSaved` hears the
 * deck revision of every snapshot once it is on disk. */
export function createDeckPersistence(
  deck: DeckStore,
  onNotices: (notices: readonly string[]) => void = () => {},
  onSaved: (revision: number) => void = () => {},
): DeckPersistence {
  const actions = createDeckActions(deck);
  const listeners = new Set<() => void>();
  let snapshot: DeckPersistenceSnapshot = { restoring: true, frozen: null, load: null };
  let load: DeckLoad = "loaded";
  let loaded = false;
  let frozen = false;
  /** False while this copy only shows: another holds the settings folder. */
  let writable = true;
  let disposed = false;
  let lastSaved: string | null = null;
  let lastImmediate: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirtySince: number | null = null;
  let saving = false;
  let docExtras: Record<string, unknown> = {};
  let serialized = serializeSnapshot();
  let immediate = deckImmediateKey(deck.getSnapshot());

  function emit(next: DeckPersistenceSnapshot): void {
    if (
      next.restoring === snapshot.restoring &&
      next.frozen === snapshot.frozen &&
      next.load === snapshot.load
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
    if (disposed || frozen || !writable) return;
    clearTimer();
    dirtySince = null;
    if (saving) return;
    const serializedAtStart = serialized;
    const immediateAtStart = immediate;
    const revisionAtStart = deck.revision();
    saving = true;
    void saveDeckState(serializedAtStart).then(
      () => {
        if (disposed) return;
        lastSaved = serializedAtStart;
        lastImmediate = immediateAtStart;
        saving = false;
        // A revision that came while it was out, writing nothing past it, is
        // on disk with it — the save that follows a change of its own may
        // never come.
        onSaved(serialized === serializedAtStart ? deck.revision() : revisionAtStart);
        if (serialized !== serializedAtStart) flushNow();
      },
      (error) => {
        if (disposed) return;
        log.warn(
          "web:persist",
          `deck state save failed: ${errorMessage(error)}`,
        );
        saving = false;
        retryLater();
      },
    );
  }

  function reconcileSave(): void {
    if (!loaded || serialized === lastSaved || frozen || disposed || !writable) return;
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
    immediate = deckImmediateKey(deck.getSnapshot());
    // A revision that writes nothing new — the file already says this deck —
    // is on disk as it stands: nothing will ever be saved to say so, and a
    // deck command answered at it would wait for that save for good.
    if (loaded && !saving && serialized === lastSaved && !frozen && writable && !disposed) onSaved(deck.revision());
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
        load = "newer";
        emit({
          restoring: true,
          frozen: {
            kind: "newer-build",
            version: result.version,
            minVersion: result.minVersion,
          },
          load: null,
        });
        return;
      }
      if (result.kind === "corrupt") {
        log.error(
          "web:persist",
          "deck state unusable → quarantined, starting empty",
        );
        // Waited on: whether the unreadable file was set aside is part of
        // how the deck loaded.
        return quarantineDeckState().then(
          () => {
            load = "quarantined";
          },
          (error) => {
            load = "quarantineFailed";
            log.error(
              "web:persist",
              `quarantine itself failed: ${errorMessage(error)}`,
            );
          },
        );
      }
      docExtras = result.deck.docExtras;
      actions.hydrate(result.deck.state);
      if (result.deck.notices.length > 0) {
        // In the log as well as on screen: the notification lives one
        // launch, and a team that went missing is a question somebody asks
        // a day later.
        for (const note of result.deck.notices) log.info("web:persist", `migrated: ${note}`);
        onNotices(result.deck.notices);
      }
    })
    .catch((error) => {
      if (disposed) return;
      log.error(
        "web:persist",
        `deck state load failed → session parked, saving disabled: ${errorMessage(error)}`,
      );
      frozen = true;
      load = "readFailed";
      emit({ restoring: true, frozen: { kind: "unreadable" }, load: null });
    })
    .finally(() => {
      if (disposed) return;
      loaded = true;
      deckChanged();
      emit({ restoring: false, frozen: snapshot.frozen, load });
    });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mayWrite(may) {
      if (may === writable) return;
      writable = may;
      if (may) reconcileSave();
      else clearTimer();
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
