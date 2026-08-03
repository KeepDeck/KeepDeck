/**
 * The one queue that orders arming against teardown.
 */

/** Run `work` after everything already queued. */
export type InOrder = <T>(work: () => Promise<T>) => Promise<T>;

export function createOrderQueue(): InOrder {
  /**
   * The one queue that orders arming against teardown.
   *
   * THE invariant this module exists for: staging arms every live spawn root
   * with a `.agents/skills` symlink, and a removal deletes a root's whole
   * directory. Run concurrently, an arming lands between git's recursive delete
   * and its final `rmdir`, which then fails on a directory that is no longer a
   * worktree — an orphaned branch and a husk nothing can clear. Because both
   * sides pass through here, the ordering is a property of this object rather
   * than a convention its callers have to keep.
   *
   * One queue for all workspaces, deliberately: staging is a directory copy and
   * a removal is a user closing panes, so nothing here is hot enough to split,
   * and a finer queue would have to know which repository a root belongs to —
   * knowledge that lives a layer down, in git.
   */
  let queue: Promise<unknown> = Promise.resolve();

  /** Run `work` after everything already queued. A failure inside `work` is the
   * caller's to handle and must not stall the queue for everyone else. */
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }
  return inOrder;
}
