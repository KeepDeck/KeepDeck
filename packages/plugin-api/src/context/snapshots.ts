/**
 * Serializable projections of deck state — what plugins see instead of the
 * deck's own live objects. Snapshots keep the contract transport-agnostic:
 * the same shapes cross the in-process boundary today and the postMessage
 * RPC boundary on the external tier unchanged.
 */

/** Serializable identity of one workspace lifetime. The public `id` may be
 * reused after close; `instance` never is. */
export interface WorkspaceRef {
  readonly id: string;
  readonly instance: string;
}

export interface WorkspaceSnapshot extends WorkspaceRef {
  name: string;
  cwd: string;
  panes: PaneSnapshot[];
  /** The teams running here — every one, whether or not a pane is on it.
   * A pane's `team` names one of these by id. */
  teams: TeamSnapshot[];
}

/** A team: the unit that owns a directory. Its members are the panes whose
 * `team` is this id; which of its facts a plugin may act on is the host's
 * business — a folder no pane runs in is not one the fs and git services
 * reach. */
export interface TeamSnapshot {
  id: string;
  name: string;
  /** The directory the team's agents run in; absent while it is still being
   * created. */
  cwd?: string;
  /** The branch the team works on — the one its worktree has, or the one its
   * create is heading for. */
  branch?: string;
}

export interface PaneSnapshot {
  id: string;
  name: string;
  /** The pane's working directory; absent while provisioning. */
  cwd?: string;
  branch?: string;
  agentType: string;
  /** The id of the team the pane is on, when it is on one. */
  team?: string;
}
