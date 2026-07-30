import type { SpawnPlan } from "../domain/agents";
import { findWorkspaceOfPane, paneIsRemoteFresh } from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import { bumpPostback } from "./postbacks";
import {
  bindPaneSpawnSpecSession,
  peekPaneSpawnSpec,
} from "./spawnSpecs";
import { beginPaneUsageSession } from "./usageManager";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";

/**
 * Session identity v2 ([F7]/[F8]): bindings arrive as `deck://session/bound`
 * events — the pane's own agent process reported its session id through the
 * CLI bridge (hook/plugin armed at spawn, correlated by the env-injected
 * pane id). EVERY agent's identity is reporter-based — claude included; its
 * SessionStart hook posts the self-minted id at startup. This service is a
 * thin subscriber: find the pane's workspace, verify the postback's token,
 * record the binding. No discovery, no timers — the id comes from the source.
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
export interface SessionBinding {
  dispose(): void;
}

export function createSessionBinding(deck: DeckStore): SessionBinding {
  const actions = createDeckActions(deck);
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void onSessionBound(
    ({ paneId, sessionId, token, transcriptPath }) => {
      if (disposed) return;
      const state = deck.getSnapshot();
      if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
        log.warn(
          "web:bridge",
          `postback for ${paneId} with a wrong token — ignored`,
        );
        return;
      }
      // Counted even when the pane's workspace is already gone — the count
      // answers "did this spawn's process ever report?", nothing else.
      bumpPostback(paneId);
      // The postback may outlive its pane (agent reported just as the pane
      // closed) — no workspace match means there's nothing to bind.
      const ws = findWorkspaceOfPane(state.workspaces, paneId);
      if (!ws) return;
      const pane = ws.panes.find((candidate) => candidate.id === paneId);
      // Remote panes run a local thin-client whose reporter fires too, but a
      // remote pane is fresh-session only — it must NOT bind a resumable
      // LOCAL session.
      if (pane && paneIsRemoteFresh(pane)) return;
      bindPaneSpawnSpecSession(paneId, sessionId);
      const previousSessionId = pane?.session?.id;
      if (previousSessionId && previousSessionId !== sessionId) {
        beginPaneUsageSession(paneId, sessionId);
      }
      // Same-session reports keep the instant at which it was first bound.
      const boundAt =
        previousSessionId === sessionId
          ? (pane?.session?.boundAt ?? new Date().toISOString())
          : new Date().toISOString();
      actions.setPaneSession(
        ws.id,
        paneId,
        { id: sessionId, boundAt },
        transcriptPath,
      );
    },
  )
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else unlisten = unsubscribe;
    })
    .catch((error) => {
      if (!disposed) {
        log.warn("web:bridge", `session binding listener failed: ${error}`);
      }
    });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unlisten?.();
    },
  };
}
