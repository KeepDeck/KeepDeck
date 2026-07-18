import { useEffect, useRef } from "react";
import type { AgentUsage } from "@keepdeck/plugin-api";
import { findWorkspaceOfPane, paneAgentType } from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import { findCodexRollout, unwatchSessionFile, watchSessionFile } from "../ipc/usage";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./useSessionBinding";
import type { Deck } from "./useDeck";

/**
 * The session-file tail lane, for agents whose contribution declares a
 * `tail` dialect. Two arming paths, one garbage collector:
 *
 * - A binding carrying a transcript path arms the declared tail (rebinds
 *   replace it).
 * - Codex's interactive `resume` fires no SessionStart hook (observed on
 *   0.144.5), so a revived codex pane never binds — the fallback resolves
 *   the rollout from the pane's RECORDED session id, retried on a slow
 *   timer until the spawn token and the file exist.
 * - The sweep unwatches tails whose panes left the deck.
 *
 * The native commands are async; a pane can close while one is in flight,
 * AFTER the sweep already ran its unwatch. Every arm therefore re-checks
 * intent on completion and undoes a landing the sweep missed — without
 * this, a close-during-arm leaks a native watcher forever.
 */

/** How often the fallback lane re-tries panes it could not arm yet. */
export const TAIL_RETRY_MS = 20_000;

export function useUsageTails(
  deck: Deck,
  usageByAgent: ReadonlyMap<string, AgentUsage>,
): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const usageByAgentRef = useRef(usageByAgent);
  usageByAgentRef.current = usageByAgent;
  // Panes with a live (or in-flight) tail — the sweep's unwatch list.
  const tailedRef = useRef(new Set<string>());

  const settleArm = (paneId: string) => {
    if (!tailedRef.current.has(paneId)) void unwatchSessionFile(paneId);
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onSessionBound(({ paneId, token, transcriptPath }) => {
      // Skips are logged at debug: a silent gate here once cost a blind
      // debugging session ("tail broken" vs "tail never armed").
      if (!transcriptPath) {
        log.debug("web:usage", `${paneId}: binding carries no transcript — no tail`);
        return;
      }
      if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) return;
      const ws = findWorkspaceOfPane(deckRef.current.workspaces, paneId);
      const pane = ws?.panes.find((p) => p.id === paneId);
      if (!pane) return;
      const format = usageByAgentRef.current.get(paneAgentType(pane))?.tail;
      if (!format) {
        log.debug("web:usage", `${paneId}: agent declares no tail — skipped`);
        return;
      }
      log.debug("web:usage", `${paneId}: arming ${format} tail from binding`);
      tailedRef.current.add(paneId);
      watchSessionFile(paneId, transcriptPath, token, format)
        .then(() => settleArm(paneId))
        .catch((e) =>
          log.warn("web:usage", `session-file tail for ${paneId} failed: ${e}`),
        );
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const armRecordedTails = () => {
    for (const ws of deckRef.current.workspaces) {
      for (const pane of ws.panes) {
        if (pane.dormant || pane.provisioning) continue;
        const sessionId = pane.session?.id;
        if (!sessionId || tailedRef.current.has(pane.id)) continue;
        if (usageByAgentRef.current.get(paneAgentType(pane))?.tail !== "codex") {
          continue;
        }
        const token = peekPaneSpawnSpec(pane.id)?.token;
        if (!token) continue;
        const paneId = pane.id;
        tailedRef.current.add(paneId);
        log.debug("web:usage", `${paneId}: fallback lookup for ${sessionId}`);
        findCodexRollout(sessionId)
          .then((path) => {
            if (!path) {
              log.debug("web:usage", `${paneId}: no rollout for ${sessionId} yet`);
              tailedRef.current.delete(paneId);
              return;
            }
            // The pane may have closed while the lookup ran — arming now
            // would resurrect a tail the sweep already buried.
            if (!tailedRef.current.has(paneId)) return;
            return watchSessionFile(paneId, path, token, "codex").then(() =>
              settleArm(paneId),
            );
          })
          .catch((e) => {
            tailedRef.current.delete(paneId);
            log.warn("web:usage", `rollout lookup for ${paneId} failed: ${e}`);
          });
      }
    }
  };

  // A string key so the sweep runs only when pane MEMBERSHIP changes, not
  // on every deck render.
  const paneIds = deck.workspaces
    .flatMap((ws) => ws.panes.map((pane) => pane.id))
    .sort()
    .join("\n");
  useEffect(() => {
    const live = new Set(paneIds.split("\n").filter(Boolean));
    for (const paneId of [...tailedRef.current]) {
      if (live.has(paneId)) continue;
      tailedRef.current.delete(paneId);
      void unwatchSessionFile(paneId);
    }
    armRecordedTails();
    // The slow retry lane: the spawn token (or the rollout itself) may not
    // exist yet on the first pass; quiet no-op once everything is tailed.
    const timer = setInterval(armRecordedTails, TAIL_RETRY_MS);
    return () => clearInterval(timer);
  }, [paneIds]);
}
