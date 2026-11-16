/**
 * Putting a workspace away and bringing it back — the effects half.
 *
 * The decision is the deck's: one reducer action puts the marker on the row
 * AND marks every pane the archive stops as suspended, in one snapshot and
 * one save ([`archiveWorkspace`]), so from the first write on nothing in the
 * workspace can rise by itself — not after a crash, not after a restore.
 * What is left for this owner is what a reducer cannot do: end the processes
 * still running, wait out a worktree create that is still changing a team,
 * take KeepDeck's plantings back out of the directories, and record what it
 * could not finish so the next launch retries exactly that.
 *
 * The marker's phase is the commit point. "archiving" until this pass has
 * done what it could, "archived" after — and a workspace found "archiving"
 * with no pass running (the app quit mid-way) is a pass to finish: repair
 * runs from the orchestrator's reconcile, so it needs no boot hook and no
 * active workspace.
 *
 * Restore takes the marker off and nothing else: every pane stays as the
 * archive left it, and waking them is the person's, one by one.
 */
import {
  createIsOut,
  findWorkspaceByRef,
  teamsOf,
  type ArchiveOutcome,
  type ArchiveWarnings,
  type RestoreOutcome,
  type Workspace,
} from "../../domain/deck";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { log } from "../../ipc/log";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { dropPaneSpawnSpec } from "../spawnSpecs";
import type { WorktreeProvisioner } from "../worktrees";
import type { PaneLifecyclePort, SessionRegistryPort } from ".";
import { endPaneProcess } from "./closing";

interface ArchivingDeps {
  deck: DeckStore;
  actions: DeckActions;
  sessions: SessionRegistryPort;
  worktrees: Pick<WorktreeProvisioner, "awaitSettled" | "disarmArchived">;
  lifecycle: PaneLifecyclePort;
  /** Whether a confirmed close of the whole workspace is under way. */
  closingWorkspace(workspace: WorkspaceRef): boolean;
}

export interface AgentOrchestratorArchiving {
  archive(workspace: WorkspaceRef): Promise<ArchiveOutcome>;
  restore(workspace: WorkspaceRef): RestoreOutcome;
  /** Whether this run is stopping the workspace's agents right now. */
  archiving(workspace: WorkspaceRef): boolean;
  /** Finish what an archive left undone — asked on every reconcile, cheap
   * when there is nothing to do. */
  repair(): void;
}

export function createAgentOrchestratorArchiving({
  deck,
  actions,
  sessions,
  worktrees,
  lifecycle,
  closingWorkspace,
}: ArchivingDeps): AgentOrchestratorArchiving {
  /** Passes running now, by `id#instance`. */
  const inFlight = new Set<string>();
  /** Workspaces whose leftovers this run has already tried once: a retry
   * that fails is the next launch's, not a loop's. */
  const repaired = new Set<string>();

  const keyOf = (workspace: WorkspaceRef) => `${workspace.id}#${workspace.instance}`;
  const refOf = (workspace: Workspace): WorkspaceRef => ({ id: workspace.id, instance: workspace.instance });
  const live = (workspace: WorkspaceRef) => findWorkspaceByRef(deck.getSnapshot().workspaces, workspace);
  /** The pass stops the moment the workspace is restored or closed. */
  const stillArchived = (workspace: WorkspaceRef) => live(workspace)?.archived !== undefined;

  /** End each process; answer the panes whose process did not end. */
  async function reap(paneIds: readonly string[]): Promise<string[]> {
    const ended = await Promise.allSettled(paneIds.map((paneId) => endPaneProcess({ sessions, lifecycle }, paneId)));
    return paneIds.filter((_, i) => ended[i].status === "rejected");
  }

  /** The panes of `workspace` that have a process behind them — remote
   * clients included: a thin client is ended, its server agent is not ours. */
  const running = (workspace: Workspace) =>
    workspace.panes.filter((pane) => sessions.state(pane.id).kind !== "none").map((pane) => pane.id);

  /** Everything after the reaping: wait out the creates still changing a
   * team, take the plantings back, and settle — each step only while the
   * workspace is still put away. */
  async function finish(workspace: WorkspaceRef, reaps: readonly string[]): Promise<void> {
    const before = live(workspace);
    if (!before?.archived) return;
    const making = teamsOf(before).filter((team) => createIsOut(team.location));
    await Promise.all(making.map((team) => worktrees.awaitSettled(team.id)));
    if (!stillArchived(workspace)) return;
    const disarmed = await worktrees.disarmArchived(workspace);
    const now = live(workspace);
    if (!now?.archived) return;
    if (reaps.length > 0 || !disarmed) {
      log.warn(
        "web:orchestrator",
        `${now.id}: archived with work left — ${reaps.length} agent(s) did not stop${disarmed ? "" : ", plantings not taken back"}`,
      );
    }
    actions.settleArchive(now.id, { reaps: [...reaps], disarm: !disarmed });
  }

  /** Run `pass` as the one pass for `workspace`; nothing if one is running. */
  async function exclusively(workspace: WorkspaceRef, pass: () => Promise<void>): Promise<void> {
    const key = keyOf(workspace);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await pass();
    } finally {
      inFlight.delete(key);
    }
  }

  const archive: AgentOrchestratorArchiving["archive"] = async (workspace) => {
    const ws = live(workspace);
    if (!ws) return "gone";
    if (ws.archived) return "already";
    if (closingWorkspace(workspace)) return "closing";
    await exclusively(workspace, async () => {
      // Read before the marker, in the same tick: the marker is what holds
      // everything else down from here on.
      const processes = running(ws);
      log.info("web:orchestrator", `${ws.id}: archiving — ${processes.length} process(es) to end`);
      actions.archiveWorkspace(ws.id);
      // A plan cached for a pane that is not running is a plan for a start
      // that is not coming; dropped so nothing built before the archive is
      // used after it.
      for (const pane of ws.panes) dropPaneSpawnSpec(pane.id);
      const failed = await reap(processes);
      await finish(workspace, failed);
    });
    return "archived";
  };

  const restore: AgentOrchestratorArchiving["restore"] = (workspace) => {
    const ws = live(workspace);
    if (!ws) return "gone";
    if (!ws.archived) return "not-archived";
    // A plan cached before the archive would spawn without what the archive
    // took back out of the directory: the first start after this builds anew.
    for (const pane of ws.panes) dropPaneSpawnSpec(pane.id);
    actions.restoreWorkspace(ws.id);
    log.info("web:orchestrator", `${ws.id}: restored — its agents stay as they were`);
    return "restored";
  };

  /** What the last pass owed, tried once more: the reaps (a process that
   * did not end then — after a restart there is none left to end) and the
   * take-back. Settled with whatever still fails. */
  async function retry(workspace: WorkspaceRef, owed: ArchiveWarnings): Promise<void> {
    const ws = live(workspace);
    if (!ws?.archived) return;
    const stillRunning = owed.reaps.filter((paneId) => sessions.state(paneId).kind !== "none");
    const reaps = await reap(stillRunning);
    const disarmed = owed.disarm ? await worktrees.disarmArchived(workspace) : true;
    const now = live(workspace);
    if (!now?.archived) return;
    actions.settleArchive(now.id, { reaps, disarm: !disarmed });
  }

  const repair: AgentOrchestratorArchiving["repair"] = () => {
    for (const ws of deck.getSnapshot().workspaces) {
      const marker = ws.archived;
      if (!marker) continue;
      const workspace = refOf(ws);
      const key = keyOf(workspace);
      if (inFlight.has(key) || repaired.has(key)) continue;
      if (marker.phase === "archiving") {
        repaired.add(key);
        log.info("web:orchestrator", `${ws.id}: finishing an archive left half-done`);
        void exclusively(workspace, async () => finish(workspace, await reap(running(ws))));
      } else if (marker.warnings) {
        repaired.add(key);
        const owed = marker.warnings;
        void exclusively(workspace, () => retry(workspace, owed));
      }
    }
  };

  return {
    archive,
    restore,
    archiving: (workspace) => inFlight.has(keyOf(workspace)),
    repair,
  };
}
