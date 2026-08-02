import type { PaneInputFocusPort } from "../app/paneInputFocusPort";

export interface PaneInputFocusRequest {
  readonly paneId: string | null;
  readonly version: number;
}

export interface PaneInputFocusSource {
  getSnapshot(): PaneInputFocusRequest;
  subscribe(listener: () => void): () => void;
}

export interface PaneInputFocusController
  extends PaneInputFocusPort,
    PaneInputFocusSource {
  dispose(): void;
}

const INITIAL_REQUEST: PaneInputFocusRequest = {
  paneId: null,
  version: 0,
};

/**
 * App-lifetime presentation signal. Every request is observable, including a
 * repeat for the pane that is already selected: focus is an event, not state.
 */
export function createPaneInputFocusController(): PaneInputFocusController {
  let snapshot = INITIAL_REQUEST;
  let disposed = false;
  const listeners = new Set<() => void>();

  return {
    requestFocus(paneId) {
      if (disposed) return;
      snapshot = { paneId, version: snapshot.version + 1 };
      for (const listener of listeners) listener();
    },

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
}
