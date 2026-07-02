import { useEffect, useRef } from "react";
import { onSessionBound } from "../ipc/sessions";
import type { Deck } from "./useDeck";

/**
 * Session identity v2 ([F7]/[F8]): bindings arrive as `deck://session/bound`
 * events — the pane's own agent process reported its session id through the
 * KeepDeck spool (hook/plugin armed at spawn, correlated by the env-injected
 * pane id). This hook is a thin subscriber: find the pane's workspace, record
 * the binding. No discovery, no timers — the id comes from the source.
 *
 * Rebinds are welcome: a pane's session can legitimately change mid-life
 * (opencode `/new`), and same-id rebinds are reducer no-ops.
 */
export function useSessionBinding(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onSessionBound(({ paneId, sessionId }) => {
      const d = deckRef.current;
      // The postback may outlive its pane (agent reported just as the pane
      // closed) — no workspace match means there's nothing to bind.
      const ws = d.workspaces.find((w) => w.panes.some((p) => p.id === paneId));
      if (ws) {
        d.setPaneSession(ws.id, paneId, {
          id: sessionId,
          boundAt: new Date().toISOString(),
        });
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
