import { useEffect, useRef } from "react";
import { findWorkspaceOfPane, paneAgentType } from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import { onUsageReport, unwatchRollout, watchRollout } from "../ipc/usage";
import { reportUsage, retainUsagePanes } from "./usageManager";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./useSessionBinding";
import type { Deck } from "./useDeck";

/**
 * The single mount point wiring bridge usage reports into the usage store —
 * one subscription per app (the store is a singleton; `useUsage` readers
 * mount freely, this hook must not). Verification mirrors the session
 * binding: a report counts only when it echoes the secret the pane's own
 * spawn carried.
 *
 * Codex panes need one extra move: their usage lives in the session rollout
 * file, so a codex binding that carries a transcript path arms the Rust
 * tailer (rebinds replace the tail — new session, new rollout). The retain
 * effect prunes pane usage AND tails as panes close; account chips
 * deliberately survive their reporter.
 */
export function useUsageChannel(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;
  // Panes with a live rollout tail — the retain sweep's unwatch list.
  const tailedRef = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const subscribe = (start: Promise<() => void>) =>
      void start.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });

    subscribe(
      onUsageReport(({ paneId, token, payload }) => {
        if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
          log.warn(
            "web:bridge",
            `usage report for ${paneId} with a wrong token — ignored`,
          );
          return;
        }
        reportUsage(paneId, payload);
      }),
    );

    subscribe(
      onSessionBound(({ paneId, token, transcriptPath }) => {
        if (!transcriptPath) return;
        if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) return;
        const ws = findWorkspaceOfPane(deckRef.current.workspaces, paneId);
        const pane = ws?.panes.find((p) => p.id === paneId);
        if (!pane || paneAgentType(pane) !== "codex") return;
        tailedRef.current.add(paneId);
        watchRollout(paneId, transcriptPath, token).catch((e) =>
          log.warn("web:usage", `rollout tail for ${paneId} failed: ${e}`),
        );
      }),
    );

    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // A string key so the retain sweep runs only when pane MEMBERSHIP changes,
  // not on every deck render.
  const paneIds = deck.workspaces
    .flatMap((ws) => ws.panes.map((pane) => pane.id))
    .sort()
    .join("\n");
  useEffect(() => {
    const live = new Set(paneIds.split("\n").filter(Boolean));
    retainUsagePanes(live);
    for (const paneId of [...tailedRef.current]) {
      if (live.has(paneId)) continue;
      tailedRef.current.delete(paneId);
      void unwatchRollout(paneId);
    }
  }, [paneIds]);
}
