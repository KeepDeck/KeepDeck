import { findWorkspaceOfPane, locationOf } from "../domain/deck";
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

/** A binding the pane's own agent actually landed — what everything
 * downstream of the rule is allowed to act on. */
export interface AcceptedBinding {
  readonly paneId: string;
  readonly sessionId: string;
  /** The pane's bridge secret, echoed for lanes that authenticate a watch. */
  readonly token: string;
  readonly transcriptPath?: string;
}

export interface SessionBinding {
  /** Follow the bindings this lane ACCEPTED. The verdict is stateful — it
   * pins a generation to a process — so it must be reached exactly once per
   * report; a second subscriber judging the same event would be told its own
   * predecessor had already bound. Consumers take the outcome, not the
   * question. */
  subscribe(listener: (bound: AcceptedBinding) => void): () => void;
  dispose(): void;
}

export function createSessionBinding(
  deck: DeckStore,
  lifecycle: PaneLifecycle,
  attribution: PaneAttribution,
): SessionBinding {
  const actions = createDeckActions(deck);
  const listeners = new Set<(bound: AcceptedBinding) => void>();
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
            report.agent
          } source=${report.source ?? "unreported"} reporter=${
            report.reporter ?? "unreported"
          }`,
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
      if (pane && locationOf(pane).kind === "remote") return;
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
      const accepted: AcceptedBinding = {
        paneId,
        sessionId,
        token: report.token,
        ...(transcriptPath ? { transcriptPath } : {}),
      };
      for (const listener of [...listeners]) {
        // Per listener, because one lane's failure is not the others': a
        // throw here would otherwise skip every listener after it and escape
        // into the Tauri event callback, where nobody is catching it.
        try {
          listener(accepted);
        } catch (error) {
          log.warn("web:bridge", `binding listener failed for ${paneId}: ${error}`);
        }
      }
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unlisten?.();
    },
  };
}
