import {
  findWorkspaceOfPane,
  paneAgentType,
  paneHasProcess,
} from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import {
  findCodexRollout,
  unwatchSessionFile,
  watchSessionFile,
} from "../ipc/usage";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./sessionBinding";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

export const TAIL_RETRY_MS = 20_000;

/** Session-file watcher lane, including Codex's resume-without-binding fallback. */
export function createUsageTailsLane({
  deck,
  declarations,
}: UsageLaneContext): UsageLane {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const tailed = new Set<string>();

  const settleArm = (paneId: string) => {
    if (disposed || !tailed.has(paneId)) {
      void unwatchSessionFile(paneId);
    }
  };

  const desiredPanes = () => {
    const desired = new Set<string>();
    const usage = declarations.current();
    for (const workspace of deck.getSnapshot().workspaces) {
      for (const pane of workspace.panes) {
        if (
          paneHasProcess(pane) &&
          usage.get(paneAgentType(pane))?.tail
        ) {
          desired.add(pane.id);
        }
      }
    }
    return desired;
  };

  const armRecordedTails = () => {
    if (disposed) return;
    const usage = declarations.current();
    for (const workspace of deck.getSnapshot().workspaces) {
      for (const pane of workspace.panes) {
        if (!paneHasProcess(pane)) continue;
        const sessionId = pane.session?.id;
        if (!sessionId || tailed.has(pane.id)) continue;
        if (usage.get(paneAgentType(pane))?.tail !== "codex") continue;
        const token = peekPaneSpawnSpec(pane.id)?.token;
        if (!token) continue;

        const paneId = pane.id;
        tailed.add(paneId);
        log.debug("web:usage", `${paneId}: fallback lookup for ${sessionId}`);
        void findCodexRollout(sessionId)
          .then((path) => {
            if (!path) {
              log.debug(
                "web:usage",
                `${paneId}: no rollout for ${sessionId} yet`,
              );
              tailed.delete(paneId);
              return;
            }
            if (disposed || !tailed.has(paneId)) return;
            return watchSessionFile(
              paneId,
              path,
              token,
              "codex",
            ).then(() => settleArm(paneId));
          })
          .catch((error) => {
            tailed.delete(paneId);
            log.warn(
              "web:usage",
              `rollout lookup for ${paneId} failed: ${error}`,
            );
          });
      }
    }
  };

  const reconcile = () => {
    if (disposed) return;
    const desired = desiredPanes();
    for (const paneId of [...tailed]) {
      if (desired.has(paneId)) continue;
      tailed.delete(paneId);
      void unwatchSessionFile(paneId);
    }
    armRecordedTails();
  };

  void onSessionBound(({ paneId, token, transcriptPath }) => {
    if (disposed) return;
    if (!transcriptPath) {
      log.debug(
        "web:usage",
        `${paneId}: binding carries no transcript — no tail`,
      );
      return;
    }
    if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) return;
    const workspace = findWorkspaceOfPane(
      deck.getSnapshot().workspaces,
      paneId,
    );
    const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const format = declarations.current().get(paneAgentType(pane))?.tail;
    if (!format) {
      log.debug(
        "web:usage",
        `${paneId}: agent declares no tail — skipped`,
      );
      return;
    }

    log.debug("web:usage", `${paneId}: arming ${format} tail from binding`);
    tailed.add(paneId);
    void watchSessionFile(paneId, transcriptPath, token, format)
      .then(() => settleArm(paneId))
      .catch((error) => {
        tailed.delete(paneId);
        log.warn(
          "web:usage",
          `session-file tail for ${paneId} failed: ${error}`,
        );
      });
  })
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else unlisten = unsubscribe;
    })
    .catch((error) => {
      if (!disposed) {
        log.warn("web:usage", `tail binding listener failed: ${error}`);
      }
    });

  const unsubscribeDeck = deck.subscribe(reconcile);
  const unsubscribeDeclarations = declarations.subscribe(reconcile);
  const retryTimer = globalThis.setInterval(
    armRecordedTails,
    TAIL_RETRY_MS,
  );
  reconcile();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeDeck();
      unsubscribeDeclarations();
      globalThis.clearInterval(retryTimer);
      unlisten?.();
      for (const paneId of tailed) void unwatchSessionFile(paneId);
      tailed.clear();
    },
  };
}
