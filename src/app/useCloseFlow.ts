import { useRef, useState } from "react";
import {
  findWorkspace,
  worktreeTargets,
  type GitPosition,
  type WorktreeTarget,
} from "../domain/deck";
import { probeWorktree } from "../ipc/worktree";
import { discardWorktrees } from "./provisioning";
import { closePanes } from "./ptyManager";
import { dropPaneSpawnSpec } from "./spawnSpecs";
import { clearPaneUsage } from "./usageManager";
import type { Deck } from "./useDeck";

/** A pending close awaiting confirmation ([U6]) — an agent pane or a whole
 * workspace. Closing tears down live PTY session(s) immediately, so both are
 * confirmed before they run. `targets` is the worktrees the close could also
 * delete (empty in non-worktree mode), snapshotted — and probed for
 * existence — at open time; the modal blocks all mutation, so it can't go
 * stale. */
export type ClosingTarget = { targets: WorktreeTarget[] } & (
  | { kind: "agent"; wsId: string; paneId: string; label: string }
  | { kind: "workspace"; id: string; name: string; count: number }
);

/** Keep only targets whose directory is still there: offering to delete a
 * worktree that's already gone is noise, and taking the offer can only fail
 * (the "Folder is gone" tile, or a worktree removed under a live pane). Only
 * a positive "not there" drops a target — a probe that REJECTS (IPC trouble,
 * not a missing path) keeps it, degrading to the old always-offer behavior. */
async function liveTargets(
  candidates: WorktreeTarget[],
): Promise<WorktreeTarget[]> {
  const checked = await Promise.all(
    candidates.map((target) =>
      probeWorktree(target.path).then(
        (probe) => (probe.exists ? [target] : []),
        () => [target],
      ),
    ),
  );
  return checked.flat();
}

/**
 * Owns the confirmed-close flow: both close paths ([U6]) park a ClosingTarget
 * for the confirm dialog — once its candidate worktrees are probed, so a
 * directory that's already gone is never offered for deletion; confirming
 * removes the pane(s) from the deck AND ends their PTY sessions through the
 * ptyManager (unmounting alone no longer kills a process), then optionally
 * tears the worktrees down per the delete checkbox — after the closes settle,
 * so no worktree dir is a live cwd.
 */
export function useCloseFlow(
  deck: Deck,
  onError: (message: string) => void,
  gitPositions?: ReadonlyMap<string, GitPosition>,
) {
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  // Close requests are numbered: target probing is async, and a slower
  // earlier request must not open its dialog over a newer one's.
  const requestSeq = useRef(0);

  /** Open the confirm dialog once the candidate worktrees are probed. A close
   * with no candidates skips the probe and opens synchronously, as before. */
  const park = (
    candidates: WorktreeTarget[],
    make: (targets: WorktreeTarget[]) => ClosingTarget,
  ) => {
    const seq = ++requestSeq.current;
    const open = (targets: WorktreeTarget[]) => {
      setDeleteWorktree(false);
      setClosing(make(targets));
    };
    if (candidates.length === 0) {
      open([]);
      return;
    }
    void liveTargets(candidates).then((targets) => {
      if (seq === requestSeq.current) open(targets);
    });
  };

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    park(ws ? worktreeTargets(ws, paneId, gitPositions) : [], (targets) => ({
      kind: "agent",
      wsId,
      paneId,
      label,
      targets,
    }));
  };

  const requestCloseWorkspace = (id: string) => {
    const ws = findWorkspace(deck.workspaces, id);
    if (!ws) return;
    park(worktreeTargets(ws, undefined, gitPositions), (targets) => ({
      kind: "workspace",
      id,
      name: ws.name,
      count: ws.panes.length,
      targets,
    }));
  };

  const confirmClose = () => {
    if (!closing) return;
    const targets = deleteWorktree ? closing.targets : [];
    // Snapshot the pane ids before the reducer forgets them.
    const paneIds =
      closing.kind === "agent"
        ? [closing.paneId]
        : (deck.workspaces
            .find((w) => w.id === closing.id)
            ?.panes.map((p) => p.id) ?? []);
    // A closing workspace's plugin-owned resources (e.g. the Run plugin's
    // sessions) die through the plugin event bridge's onWorkspaceClosed —
    // no manual per-feature teardown here.
    for (const paneId of paneIds) {
      // Revoke bridge authentication before the reducer drops membership;
      // neither an in-flight reporter nor a reused pane id may write again.
      dropPaneSpawnSpec(paneId);
      clearPaneUsage(paneId);
    }
    if (closing.kind === "agent") deck.closeAgent(closing.wsId, closing.paneId);
    else deck.closeWorkspace(closing.id);
    setClosing(null);
    setDeleteWorktree(false);
    const closed = closePanes(paneIds);
    if (targets.length > 0) {
      void closed
        .then(() => discardWorktrees(targets))
        .then((failures) => {
          if (failures.length > 0)
            onError(
              `Failed to delete worktree${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`,
            );
        });
    }
  };

  const cancelClose = () => setClosing(null);

  return {
    closing,
    deleteWorktree,
    setDeleteWorktree,
    requestCloseAgent,
    requestCloseWorkspace,
    confirmClose,
    cancelClose,
  };
}
