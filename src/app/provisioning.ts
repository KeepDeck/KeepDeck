/**
 * Optimistic provisioning, reporting half: a team lands in the deck the
 * moment it is asked for — in worktree mode as a status card carrying its
 * create intent — and nothing here awaits before the user sees it.
 * Performing the actual `git worktree add`s is the worktree manager's job
 * ([`app/worktrees`]); this module holds where it reports each result as it
 * settles.
 */

/** Where the background runner reports as each owner's create settles —
 * under the id the create was asked for by. */
export interface ProvisionCallbacks {
  onResolved(ownerId: string, worktree: { cwd: string; branch: string }): void;
  onFailed(ownerId: string, error: string): void;
  /**
   * Has the owner left the deck? A no-op sink is not enough to answer this:
   * `onResolved` silently doing nothing looks exactly like success from here,
   * and the create needs to KNOW, because everything it does after the
   * directory exists is done on that owner's behalf.
   */
  abandoned(ownerId: string): boolean;
}

/** The runner's sinks for creates a TEAM asked for: the deck's team
 * provisioning actions for `wsId`, keyed by team id. Both no-op inside the
 * reducer when the team was dissolved mid-create. A team is abandoned
 * once it is out of the deck — or once a confirmed close HOLDS it
 * (`closing`): the team is still there while that close waits for this
 * very create, and what the create makes is the close's to remove, so
 * nothing past the directory runs on the team's behalf. */
export function provisionTeamsInto(
  deck: {
    resolveTeamProvisioning(
      wsId: string,
      teamId: string,
      worktree: { cwd: string; branch: string },
    ): void;
    setTeamProvisioningError(wsId: string, teamId: string, error: string | null): void;
    /** Is this team still in the deck? Read live — the create outlives the
     * render that started it. */
    hasTeam(wsId: string, teamId: string): boolean;
  },
  wsId: string,
  closing: (teamId: string) => boolean = () => false,
): ProvisionCallbacks {
  return {
    onResolved: (teamId, worktree) => deck.resolveTeamProvisioning(wsId, teamId, worktree),
    onFailed: (teamId, error) => deck.setTeamProvisioningError(wsId, teamId, error),
    abandoned: (teamId) => !deck.hasTeam(wsId, teamId) || closing(teamId),
  };
}
