import { findWorkspaceOfPane, paneIsRemoteFresh } from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import { bumpPostback } from "./postbacks";
import { bindPaneSpawnSpecSession } from "./spawnSpecs";
import type { PaneAttribution } from "./paneAttribution";
import type { PaneLifecycle } from "./paneLifecycle";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";

/**
 * Session identity v2 ([F7]/[F8]): bindings arrive as `deck://session/bound`
 * events — the pane's own agent process reported its session id through the
 * CLI bridge (hook/plugin armed at spawn, correlated by the env-injected
 * pane id). EVERY agent's identity is reporter-based — claude included; its
 * SessionStart hook posts the self-minted id at startup. This service is a
 * thin subscriber: find the pane's workspace, ask whether the report may
 * speak for it, record the binding. No discovery, no timers — the id comes
 * from the source.
 *
 * Rebinds are welcome, but only the pane's OWN: a session can legitimately
 * change mid-life (a resume, `/clear`, opencode's `/new`), while a second
 * fresh session under the same pane belongs to somebody else. Both are the
 * one judgement `attribution` owns, because the usage tail subscribes to
 * this same lane and must never draw a different conclusion from it.
 */

export interface SessionBinding {
  dispose(): void;
}

export function createSessionBinding(
  deck: DeckStore,
  lifecycle: PaneLifecycle,
  attribution: PaneAttribution,
): SessionBinding {
  const actions = createDeckActions(deck);
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void onSessionBound(
    (report) => {
      if (disposed) return;
      const { paneId, sessionId, transcriptPath } = report;
      const state = deck.getSnapshot();
      const verdict = attribution.judge(report);
      if (!verdict.accepted) {
        // The raw fields ride into the log because this is where an agent we
        // have not met announces itself: a refusal naming an unfamiliar
        // source is the signal that its vocabulary needs a word here.
        log.warn(
          "web:bridge",
          `binding for ${paneId} refused (${verdict.refusal}) — agent=${
            report.agent ?? "unreported"
          } source=${report.source ?? "unreported"}`,
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
      // Recorded where the binding actually lands, not at the verdict: a
      // report that reaches no pane has claimed nothing, and a remote pane
      // that deliberately binds nothing must not read as already bound.
      attribution.recordBinding(paneId, report.reporter);
      bindPaneSpawnSpecSession(paneId, sessionId);
      const previousSessionId = pane?.session?.id;
      if (previousSessionId && previousSessionId !== sessionId) {
        lifecycle.beginSession(paneId, sessionId);
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
