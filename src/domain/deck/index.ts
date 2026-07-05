/**
 * Deck — the core model: workspaces owning agent panes, the grid layout, the
 * deck reducer, hit-test geometry for pane/rail drag-and-drop, close-hotkey
 * policy, and the deck document's schema + tolerant codec (persist).
 */
export * from "./hotkeys";
export * from "./layout";
export * from "./paneDnd";
export * from "./panes";
export * from "./persist";
export * from "./railDnd";
export * from "./reducer";
export * from "./workspaceRun";
export * from "./workspaces";
