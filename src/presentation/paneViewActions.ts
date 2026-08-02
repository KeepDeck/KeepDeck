import type { PaneInputFocusPort } from "../app/paneInputFocusPort";

export interface PaneViewActions {
  toggleMaximize(workspaceId: string, paneId: string): void;
}

/** Presentation policy shared by the pane chrome and its menu hotkey. */
export function createPaneViewActions(
  toggleMaximize: (workspaceId: string, paneId: string) => void,
  paneInputFocus: PaneInputFocusPort,
): PaneViewActions {
  return {
    toggleMaximize(workspaceId, paneId) {
      toggleMaximize(workspaceId, paneId);
      // The chrome button receives browser focus before its click. Selection
      // may already be unchanged, so an explicit request must follow layout.
      paneInputFocus.requestFocus(paneId);
    },
  };
}
