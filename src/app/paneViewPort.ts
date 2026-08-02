/** Application-facing capability for making an addressed pane visible. */
export interface PaneViewPort {
  revealPane(workspaceId: string, paneId: string): void;
}
