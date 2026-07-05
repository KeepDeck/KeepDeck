/**
 * Serializable projections of deck state — what plugins see instead of the
 * deck's own live objects. Snapshots keep the contract transport-agnostic:
 * the same shapes cross the in-process boundary today and the postMessage
 * RPC boundary on the external tier unchanged.
 */

export interface WorkspaceSnapshot {
  id: string;
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
