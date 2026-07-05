import { useState } from "react";
import {
  worktreeTargets,
  type WorktreeTarget,
} from "../domain/deck";
import { discardWorktrees } from "./provisioning";
import { closePanes } from "./ptyManager";
import { stopWorkspaceRuns } from "./runManager";
import type { Deck } from "./useDeck";

/** A pending close awaiting confirmation ([U6]) — an agent pane or a whole
 * workspace. Closing tears down live PTY session(s) immediately, so both are
 * confirmed before they run. `targets` is the worktrees the close could also
 * delete (empty in non-worktree mode), snapshotted at open time — the modal
 * blocks all mutation, so it can't go stale. */
export type ClosingTarget = { targets: WorktreeTarget[] } & (
  | { kind: "agent"; wsId: string; paneId: string; label: string }
  | { kind: "workspace"; id: string; name: string; count: number }
);

/**
 * Owns the confirmed-close flow: both close paths ([U6]) park a ClosingTarget
 * for the confirm dialog; confirming removes the pane(s) from the deck AND
 * ends their PTY sessions through the ptyManager (unmounting alone no longer
 * kills a process), then optionally tears the worktrees down per the delete
 * checkbox — after the closes settle, so no worktree dir is a live cwd.
 */
export function useCloseFlow(deck: Deck, onError: (message: string) => void) {
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = deck.workspaces.find((w) => w.id === wsId);
    setDeleteWorktree(false);
    setClosing({
      kind: "agent",
      wsId,
      paneId,
      label,
      targets: ws ? worktreeTargets(ws, paneId) : [],
    });
  };

  const requestCloseWorkspace = (id: string) => {
    const ws = deck.workspaces.find((w) => w.id === id);
    if (!ws) return;
    setDeleteWorktree(false);
    setClosing({
      kind: "workspace",
      id,
      name: ws.name,
      count: ws.panes.length,
      targets: worktreeTargets(ws),
    });
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
    if (closing.kind === "agent") deck.closeAgent(closing.wsId, closing.paneId);
    else {
      deck.closeWorkspace(closing.id);
      // The workspace's run sessions (the Run panel's world) die with it —
      // a dev server outliving its workspace would be a leak.
      stopWorkspaceRuns(closing.id);
    }
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
