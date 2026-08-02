/** Application-facing capability for handing keyboard input to a live pane. */
export interface PaneInputFocusPort {
  requestFocus(paneId: string): void;
}
