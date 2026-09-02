import {
  findWorkspaceOfPane,
  paneAgentType,
  paneHasProcess,
} from "../domain/deck";
import { log } from "../ipc/log";
import { unwatchSessionFile, watchSessionFile } from "../ipc/usage";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

export const TAIL_RETRY_MS = 20_000;

/** Session-file watcher lane, including Codex's resume-without-binding fallback. */
export function createUsageTailsLane({
  deck,
  declarations,
  bindings,
  tailOf,
}: UsageLaneContext): UsageLane {
  let disposed = false;
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
        const agentId = paneAgentType(pane);
        const dialect = tailOf(agentId);
        if (!dialect) {
          // Nothing to ask. An agent whose plugin declares no dialect has no
          // store this lane can find on its own — the host used to know
          // where one CLI kept its files, and that knowledge went home.
          continue;
        }
        tailed.add(paneId);
        log.debug("web:usage", `${paneId}: asking ${agentId} to find ${sessionId}`);
        void dialect
          .follow({ sessionId, store: null, cwd: pane.cwd ?? null })
          .then((request) => {
            const path = (request as { path?: string } | null)?.path;
            if (!path) {
              log.debug(
                "web:usage",
                `${paneId}: ${agentId} has no store for ${sessionId} yet`,
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
              // Read HERE rather than before the search: finding a store is
              // a walk, and a plugin toggled during it would leave this
              // arming a dialect that is no longer declared.
              tailOf(agentId)?.watches,
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

  // ACCEPTED bindings, not raw reports. Judging the report a second time here
  // would ask a stateful question twice: the binding lane pins the pane's
  // generation as it accepts, so this lane's own verdict on the very same
  // report would come back "already bound" and the tail would never arm.
  const unsubscribeBindings = bindings.subscribe((bound) => {
    if (disposed) return;
    const { paneId, transcriptPath, token } = bound;
    if (!transcriptPath) {
      log.debug(
        "web:usage",
        `${paneId}: binding carries no transcript — no tail`,
      );
      return;
    }
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

    // The agent's own declaration of which records to carry, handed through
    // verbatim: the backend applies it without reading it.
    const watches = tailOf(paneAgentType(pane))?.watches;
    log.debug(
      "web:usage",
      `${paneId}: arming ${format} tail from binding${watches?.length ? `, carrying ${watches.length} record shape(s) for its dialect` : ""}`,
    );
    tailed.add(paneId);
    void watchSessionFile(paneId, transcriptPath, token, format, watches)
      .then(() => settleArm(paneId))
      .catch((error) => {
        tailed.delete(paneId);
        log.warn(
          "web:usage",
          `session-file tail for ${paneId} failed: ${error}`,
        );
      });
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
      unsubscribeBindings();
      for (const paneId of tailed) void unwatchSessionFile(paneId);
      tailed.clear();
    },
  };
}
