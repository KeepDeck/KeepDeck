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
}

export interface PaneSnapshot {
  id: string;
  name: string;
  /** The pane's working directory; absent while provisioning. */
  cwd?: string;
  branch?: string;
  agentType: string;
}
