/**
 * The render snapshot the deck reads, and the notes that go into it.
 *
 * Kept apart from the reconcile loop because the two answer different
 * questions: the loop decides what should happen to a pane, this decides what
 * the UI is currently told. The maps live here so "drop notes about panes
 * that are gone" is one operation rather than three places remembering to do
 * it.
 */
import type { SpawnPlan } from "../../domain/agents";
import { peekPanePlanError, peekPaneSpawnSpec } from "../spawnSpecs";
import type { DeckStore } from "../deckStore";
import type { AgentRunView } from ".";

const EMPTY_VIEW: AgentRunView = {
  blocked: {},
  wakeFailed: {},
  specs: {},
  planFailed: new Set(),
  epochs: {},
};

export interface RunViewStore {
  get(): AgentRunView;
  subscribe(listener: () => void): () => void;
  /** Recompute the snapshot and tell every listener. */
  publish(): void;
  /** The pane's directory is gone; the card says so until it is relocated. */
  markBlocked(paneId: string, dir: string): void;
  /** A manual wake refused, with the reason its card shows. */
  markWakeFailed(paneId: string, why: string): void;
  blockedDir(paneId: string): string | null;
  /** Forget both notes for one pane; `true` when anything was there. */
  clearNotes(paneId: string): boolean;
  /** Terminal mount generations — a restart re-mounts by bumping one. */
  epochs: Map<string, number>;
  /** Panes whose directory is gone, by pane id. Handed to the collaborators
   * that both write it (the close flow relocating a pane) and read it. */
  blocked: Map<string, string>;
  /** Drop notes about panes that are no longer in the deck; `true` when any
   * went. Ids are never reused, so without this the maps only grow. */
  forgetGone(live: Set<string>): boolean;
}

export function createRunViewStore(deck: DeckStore): RunViewStore {
  const blocked = new Map<string, string>();
  const wakeFailed = new Map<string, string>();
  const epochs = new Map<string, number>();
  const listeners = new Set<() => void>();
  let view: AgentRunView = EMPTY_VIEW;

  function publish(): void {
    // The plan snapshot is read off the shared cache rather than mirrored:
    // resume and fork plans are written there by other paths, and a second
    // copy here would be a second answer to "what does this pane run".
    const specs: Record<string, SpawnPlan> = {};
    const planFailed = new Set<string>();
    for (const ws of deck.getSnapshot().workspaces) {
      for (const pane of ws.panes) {
        const spec = peekPaneSpawnSpec(pane.id);
        if (spec) specs[pane.id] = spec;
        if (peekPanePlanError(pane.id)) planFailed.add(pane.id);
      }
    }
    view = {
      blocked: Object.fromEntries(blocked),
      wakeFailed: Object.fromEntries(wakeFailed),
      specs,
      planFailed,
      epochs: Object.fromEntries(epochs),
    };
    for (const listener of [...listeners]) listener();
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish,
    markBlocked: (paneId, dir) => {
      blocked.set(paneId, dir);
    },
    markWakeFailed: (paneId, why) => {
      wakeFailed.set(paneId, why);
    },
    blockedDir: (paneId) => blocked.get(paneId) ?? null,
    clearNotes(paneId) {
      let changed = blocked.delete(paneId);
      changed = wakeFailed.delete(paneId) || changed;
      return changed;
    },
    epochs,
    blocked,
    forgetGone(live) {
      let dropped = false;
      for (const map of [blocked, wakeFailed, epochs]) {
        for (const paneId of [...map.keys()]) {
          if (!live.has(paneId)) {
            map.delete(paneId);
            dropped = true;
          }
        }
      }
      return dropped;
    },
  };
}
