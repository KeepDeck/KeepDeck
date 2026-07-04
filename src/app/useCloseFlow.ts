import { useState } from "react";
import {
  worktreeTargets,
  type WorktreeTarget,
} from "../domain/workspaces";
import { discardWorktrees } from "./provisioning";
import { closePanes } from "./ptyManager";
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
 *
 * With `confirmBeforeClose` off ([F6]) a request acts immediately — and never
 * deletes worktrees, since that opt-in checkbox lives inside the skipped
 * dialog.
 */
export function useCloseFlow(
  deck: Deck,
  onError: (message: string) => void,
  confirmBeforeClose: boolean,
) {
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);

  const performClose = (target: ClosingTarget, discard: WorktreeTarget[]) => {
    // Snapshot the pane ids before the reducer forgets them.
    const paneIds =
      target.kind === "agent"
        ? [target.paneId]
        : (deck.workspaces
            .find((w) => w.id === target.id)
            ?.panes.map((p) => p.id) ?? []);
    if (target.kind === "agent") deck.closeAgent(target.wsId, target.paneId);
    else deck.closeWorkspace(target.id);
    const closed = closePanes(paneIds);
    if (discard.length > 0) {
      void closed
        .then(() => discardWorktrees(discard))
        .then((failures) => {
          if (failures.length > 0)
            onError(
              `Failed to delete worktree${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`,
            );
        });
    }
  };

  const request = (target: ClosingTarget) => {
    if (!confirmBeforeClose) {
      performClose(target, []);
      return;
    }
    setDeleteWorktree(false);
    setClosing(target);
  };

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = deck.workspaces.find((w) => w.id === wsId);
    request({
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
    request({
      kind: "workspace",
      id,
      name: ws.name,
      count: ws.panes.length,
      targets: worktreeTargets(ws),
    });
  };

  const confirmClose = () => {
    if (!closing) return;
    setClosing(null);
    setDeleteWorktree(false);
    performClose(closing, deleteWorktree ? closing.targets : []);
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
