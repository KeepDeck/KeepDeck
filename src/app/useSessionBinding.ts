import { useEffect, useRef } from "react";
import { findWorkspaceOfPane } from "../domain/deck";
import { onSessionBound } from "../ipc/sessions";
import { peekPaneSpawnSpec } from "./spawnSpecs";
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

  // Assigned identities (claude): the spawn plan minted the id, so bind the
  // moment the pane is live — nothing to wait for. Never overrides an
  // existing binding (a reporter's word wins over the assignment).
  useEffect(() => {
    const d = deckRef.current;
    for (const ws of deck.workspaces) {
      for (const pane of ws.panes) {
        if (pane.dormant || pane.session) continue;
        const spec = peekPaneSpawnSpec(pane.id);
        if (spec?.sessionId) {
          d.setPaneSession(ws.id, pane.id, {
            id: spec.sessionId,
            boundAt: new Date().toISOString(),
          });
        }
      }
    }
  }, [deck.workspaces]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onSessionBound(({ paneId, sessionId }) => {
      const d = deckRef.current;
      // The postback may outlive its pane (agent reported just as the pane
      // closed) — no workspace match means there's nothing to bind.
      const ws = findWorkspaceOfPane(d.workspaces, paneId);
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
