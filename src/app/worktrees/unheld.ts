/**
 * Removing a checkout no team holds — the body `removeUnheld` runs inside
 * the worktree queue's slot.
 *
 * Asked again here, inside the slot, whether anyone holds the folder: the
 * window read its list a moment (or a minute) ago, and a team may have
 * landed in it since. The branch always stays — a branch's commits are not
 * this removal's to drop. A detached checkout's commit is kept as a tag
 * FIRST, and when that cannot be done nothing is removed.
 */
import { errorMessage } from "@keepdeck/plugin-api";
import { removeWorktree, saveWorktreeHead } from "../../ipc/worktree";
import type { UnheldRemoval, UnheldRemovalRequest } from "../../domain/deck";
import type { WorktreeDeckView } from "./index";

export async function removeUnheld(
  deck: Pick<WorktreeDeckView, "holds">,
  request: UnheldRemovalRequest,
): Promise<UnheldRemoval> {
  if (deck.holds(request.path)) return { kind: "held" };
  let keptAs: string | undefined;
  if (request.keepHeadAs) {
    try {
      keptAs = await saveWorktreeHead(request.repo, request.path, request.keepHeadAs);
    } catch (error) {
      return { kind: "not-kept", reason: errorMessage(error) };
    }
  }
  try {
    await removeWorktree(request.repo, request.path, {
      discardDirty: request.discardDirty,
      // No branch is named: it stays, whatever it holds.
      discardUnmerged: false,
    });
    return keptAs ? { kind: "removed", keptAs } : { kind: "removed" };
  } catch (error) {
    return { kind: "failed", reason: errorMessage(error), ...(keptAs && { keptAs }) };
  }
}
