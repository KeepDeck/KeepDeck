import { useEffect, useRef } from "react";
import type { SpawnPlan } from "../domain/agents";
import { findWorkspaceOfPane } from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import { bumpPostback } from "./postbacks";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import type { Deck } from "./useDeck";

/**
 * Session identity v2 ([F7]/[F8]): bindings arrive as `deck://session/bound`
 * events — the pane's own agent process reported its session id through the
 * CLI bridge (hook/plugin armed at spawn, correlated by the env-injected
 * pane id). EVERY agent's identity is reporter-based — claude included; its
 * SessionStart hook posts the self-minted id at startup. This hook is a thin
 * subscriber: find the pane's workspace, verify the postback's token, record
 * the binding. No discovery, no timers — the id comes from the source.
 *
 * Rebinds are welcome: a pane's session can legitimately change mid-life
 * (opencode `/new`), and same-id rebinds are reducer no-ops.
 */

/** A postback binds a pane only if it echoes the secret the pane's own spawn
 * carried — dropping a file into the inbox is not enough. A pane that armed
 * no reporter (no spec, no token) accepts nothing. */
export function postbackAccepted(
  spec: Pick<SpawnPlan, "token"> | undefined,
  token: string,
): boolean {
  return !!spec?.token && spec.token === token;
}
export function useSessionBinding(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onSessionBound(({ paneId, sessionId, token, transcriptPath }) => {
      const d = deckRef.current;
      if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
        log.warn("web:bridge", `postback for ${paneId} with a wrong token — ignored`);
        return;
      }
      // Counted even when the pane's workspace is already gone — the count
      // answers "did this spawn's process ever report?", nothing else.
      bumpPostback(paneId);
      // The postback may outlive its pane (agent reported just as the pane
      // closed) — no workspace match means there's nothing to bind.
      const ws = findWorkspaceOfPane(d.workspaces, paneId);
      if (ws) {
        d.setPaneSession(
          ws.id,
          paneId,
          { id: sessionId, boundAt: new Date().toISOString() },
          transcriptPath,
        );
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
