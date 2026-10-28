import {
  findWorkspaceOfPane,
  paneHasProcess,
  paneWorktree,
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
  attribution,
  bindings,
  tailOf,
  companionOf,
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

  /** Whether this pane's process states its status facts itself: its
   * companion said hello from the process the pane is pinned to, and the
   * agent declares that the companion covers them. Then the store's status
   * records are not read at all — one source per process, never two. */
  const statusCovered = (paneId: string, agentId: string): boolean =>
    (companionOf(agentId)?.covers.includes("status-records") ?? false) &&
    attribution.hasCompanion(paneId);

  /** Everything this pane's store has to be read for. The merge — and the
   * order it must happen in — belongs to the contract, not to this lane: see
   * [`tailWatches`]. */
  const watchesFor = (paneId: string, agentId: string): readonly TailWatch[] =>
    tailWatches(
      declarations.current().get(agentId)?.tail,
      statusCovered(paneId, agentId) ? undefined : tailOf(agentId),
    );

  /** What each armed pane was armed WITH — so a companion arriving after the
   * arm can re-arm it without the status records, and only when that changes
   * what is read. */
  const armedWith = new Map<
    string,
    { path: string; token: string; agentId: string; covered: boolean }
  >();

  /** Arm one pane's follower; `false` when there is nothing left to read. */
  const arm = (paneId: string, path: string, token: string, agentId: string) => {
    const watches = watchesFor(paneId, agentId);
    armedWith.set(paneId, {
      path,
      token,
      agentId,
      covered: statusCovered(paneId, agentId),
    });
    return watchSessionFile(
      paneId,
      path,
      token,
      agentId,
      watches,
      declarations.current().get(agentId)?.tail?.siblings?.(path) ?? null,
    );
  };

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
          paneHasProcess(workspace, pane) &&
          usage.get(pane.agentType)?.tail
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
        if (!paneHasProcess(workspace, pane)) continue;
        const sessionId = pane.session?.id;
        if (!sessionId || tailed.has(pane.id) || searching.has(pane.id)) {
          continue;
        }
        const paneId = pane.id;
        const agentId = pane.agentType;
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
          // The pane's OWN directory, or null: a bare pane hands the dialect
          // nothing, not the workspace cwd — following the project root for
          // a pane that never had a worktree is a search of somebody else's
          // directory.
          .follow({ sessionId, store: null, cwd: paneWorktree(workspace, pane)?.cwd ?? null })
          .then((request) => {
            // `delete` answers whether this search was still wanted: a pane
            // that left the deck while the walk was out is dropped from the
            // set by `reconcile`, and the answer then has nowhere to go.
            const stillWanted = searching.delete(paneId);
            const path = request?.path;
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
            // The watches are read inside `arm`, after the search: finding
            // a store is a walk, and a plugin toggled during it would leave
            // this arming a declaration that is no longer made.
            return arm(paneId, path, token, agentId).then(() => settleArm(paneId));
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
      armedWith.delete(paneId);
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
    const agentId = pane.agentType;
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
    log.debug(
      "web:usage",
      `${paneId}: arming ${agentId} tail from binding${statusCovered(paneId, agentId) ? " — status stated by its companion, usage records only" : ""}`,
    );
    tailed.add(paneId);
    void arm(paneId, transcriptPath, token, agentId)
      .then(() => settleArm(paneId))
      .catch((error) => {
        tailed.delete(paneId);
        log.warn(
          "web:usage",
          `session-file tail for ${paneId} failed: ${error}`,
        );
      });
  });

  // A companion that says hello after the pane armed — or a process that
  // retired with one — changes what the store is read for. Re-armed only on
  // an actual change: the follower re-reads the store from its start.
  const unsubscribeCompanions = attribution.subscribeCompanions((paneId) => {
    if (disposed || !tailed.has(paneId)) return;
    const armed = armedWith.get(paneId);
    if (!armed || armed.covered === statusCovered(paneId, armed.agentId)) return;
    log.debug("web:usage", `${paneId}: companion changed what its tail reads — re-arming`);
    void unwatchSessionFile(paneId)
      .then(() => arm(paneId, armed.path, armed.token, armed.agentId))
      .then(() => settleArm(paneId))
      .catch((error) => {
        tailed.delete(paneId);
        armedWith.delete(paneId);
        log.warn("web:usage", `session-file re-arm for ${paneId} failed: ${error}`);
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
      unsubscribeCompanions();
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
