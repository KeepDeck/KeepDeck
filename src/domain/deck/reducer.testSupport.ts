import { createWorkspaceInstance } from "../workspaceInstance";
import { initialDeckState, type DeckState } from "./reducer";
import type { Workspace } from "./workspaces";

export const workspace = (id: string, paneIds: string[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/tmp",
  worktreeBaseDir: null,
  panes: paneIds.map((paneId) => ({ id: paneId })),
});

export const deckState = (partial: Partial<DeckState>): DeckState => ({
  ...initialDeckState,
  ...partial,
});
