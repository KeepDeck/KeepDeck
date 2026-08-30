/**
 * Optimistic provisioning, reporting half: panes land in the deck the moment
 * they're asked for — in worktree mode as status cards carrying their create
 * intent — and nothing here awaits before the user sees them. Performing the
 * actual `git worktree add`s is the worktree manager's job
 * ([`app/worktrees`]); this module holds where it reports each result as it
 * settles.
 */

/** Where the background runner reports as each pane's create settles. */
export interface ProvisionCallbacks {
  onResolved(paneId: string, worktree: { cwd: string; branch: string }): void;
  onFailed(paneId: string, error: string): void;
  /**
   * Has the pane left the deck? A no-op sink is not enough to answer this:
   * `onResolved` silently doing nothing looks exactly like success from here,
   * and the create needs to KNOW, because everything it does after the
   * directory exists is done on that pane's behalf.
   */
  abandoned(paneId: string): boolean;
}

/** The runner's usual sinks: the deck's provisioning actions for `wsId`.
 * Both no-op inside the reducer when the pane was closed mid-create. */
export function provisionInto(
  deck: {
    resolvePaneProvisioning(
      wsId: string,
      paneId: string,
      worktree: { cwd: string; branch: string },
    ): void;
    setPaneProvisioningError(
      wsId: string,
      paneId: string,
      error: string | null,
    ): void;
    /** Is this pane still in the deck? Read live — the create outlives the
     * render that started it. */
    hasPane(wsId: string, paneId: string): boolean;
  },
  wsId: string,
): ProvisionCallbacks {
  return {
    onResolved: (paneId, worktree) =>
      deck.resolvePaneProvisioning(wsId, paneId, worktree),
    onFailed: (paneId, error) =>
      deck.setPaneProvisioningError(wsId, paneId, error),
    abandoned: (paneId) => !deck.hasPane(wsId, paneId),
  };
}
