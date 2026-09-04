import {
  findWorkspaceOfPane,
  paneAgentType,
  paneHasProcess,
} from "../domain/deck";
import { tailWatches, type TailWatch } from "@keepdeck/plugin-api";
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
  /** Panes a native watcher is armed for, or is being armed for. */
  const tailed = new Set<string>();
  /**
   * Panes whose store this lane is currently ASKING a dialect to find.
   *
   * Separate from `tailed`, and that separation is the whole point: a search
   * is not an arm. Held in one set, a search that comes back empty releases
   * the pane — and if a binding armed a real tail while the search was out,
   * that release tears the tail down a moment after it was built. Which is
   * exactly what happened: a claude pane bound, armed, and was unwatched
   * within the same second, so nothing read its transcript and the card sat
   * on "working" with no edge left to finish it.
   */
  const searching = new Set<string>();

  /** Everything this agent asked to have carried out of its store. The
   * merge — and the order it must happen in — belongs to the contract, not
   * to this lane: see [`tailWatches`]. */
  const watchesFor = (agentId: string): readonly TailWatch[] =>
    tailWatches(declarations.current().get(agentId)?.tail, tailOf(agentId));

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
        if (!sessionId || tailed.has(pane.id) || searching.has(pane.id)) {
          continue;
        }
        const paneId = pane.id;
        const agentId = paneAgentType(pane);
        const tail = usage.get(agentId)?.tail;
        if (!tail) continue;
        const token = peekPaneSpawnSpec(paneId)?.token;
        if (!token) continue;

        const dialect = tailOf(agentId);
        if (!dialect) {
          // Nothing to ask. An agent whose plugin declares no dialect has no
          // store this lane can find on its own — the host used to know
          // where one CLI kept its files, and that knowledge went home.
          //
          // This used to be gated to ONE agent by name, which was the host
          // saying out loud that it knew whose sessions could be resumed
          // outside the deck. Asking whoever can be asked is the same
          // behaviour: a dialect with nothing to find answers null.
          continue;
        }
        searching.add(paneId);
        log.debug("web:usage", `${paneId}: asking ${agentId} to find ${sessionId}`);
        void dialect
          .follow({ sessionId, store: null, cwd: pane.cwd ?? null })
          .then((request) => {
            // `delete` answers whether this search was still wanted: a pane
            // that left the deck while the walk was out is dropped from the
            // set by `reconcile`, and the answer then has nowhere to go.
            const stillWanted = searching.delete(paneId);
            const path = (request as { path?: string } | null)?.path;
            if (!path) {
              log.debug(
                "web:usage",
                `${paneId}: ${agentId} has no store for ${sessionId} yet`,
              );
              return;
            }
            // A binding may have armed this pane while the search was out —
            // its tail is the better one, built from a path the agent
            // REPORTED rather than one found by walking. Leave it alone.
            if (disposed || !stillWanted || tailed.has(paneId)) return;
            tailed.add(paneId);
            return watchSessionFile(
              paneId,
              path,
              token,
              agentId,
              // Read HERE rather than before the search: finding a store is
              // a walk, and a plugin toggled during it would leave this
              // arming a declaration that is no longer made.
              watchesFor(agentId),
              declarations.current().get(agentId)?.tail?.siblings?.(path) ??
                null,
            ).then(() => settleArm(paneId));
          })
          .catch((error) => {
            // Only the search is abandoned. A tail armed from a binding
            // meanwhile is untouched — a failed WALK says nothing about a
            // path the agent reported for itself.
            searching.delete(paneId);
            log.warn(
              "web:usage",
              `store lookup for ${paneId} failed: ${error}`,
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
    // A pane that left the deck while its store was being looked for: the
    // answer, when it comes, has nowhere to go.
    for (const paneId of [...searching]) {
      if (!desired.has(paneId)) searching.delete(paneId);
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
    const agentId = paneAgentType(pane);
    const tail = declarations.current().get(agentId)?.tail;
    if (!tail) {
      log.debug(
        "web:usage",
        `${paneId}: agent declares no tail — skipped`,
      );
      return;
    }

    // The agent's own declaration of which records to carry, handed through
    // verbatim: the backend applies it without reading it.
    const watches = watchesFor(agentId);
    const siblings = tail.siblings?.(transcriptPath) ?? null;
    log.debug(
      "web:usage",
      `${paneId}: arming ${agentId} tail from binding, carrying ${watches.length} record shape(s) it declared${siblings ? ` plus whatever lands in ${siblings}` : ""}`,
    );
    tailed.add(paneId);
    void watchSessionFile(
      paneId,
      transcriptPath,
      token,
      agentId,
      watches,
      siblings,
    )
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
      searching.clear();
    },
  };
}
