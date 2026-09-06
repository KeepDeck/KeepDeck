import { createWorkspaceInstance } from "../workspaceInstance";
import { initialDeckState, type DeckState } from "./reducer";
import type { Team } from "./teams";
import type { Workspace } from "./workspaces";

export const workspace = (id: string, paneIds: string[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/tmp",
  worktreeBaseDir: null,
  panes: paneIds.map((paneId) => ({ id: paneId })),
});

/** A team on the workspace root, named after its id. */
export const team = (id: string): Team => ({
  id,
  name: id,
  location: { kind: "attached", cwd: "/tmp" },
});

/** A workspace whose panes are all on ONE team — the shape most of the
 * view's transitions are asked about, since a highlight only ever lives
 * inside an open team. Each pane's role is its own id: unique, which is
 * all the reducer asks of a role. */
export const teamedWorkspace = (
  id: string,
  paneIds: string[],
  teamId = "team-1",
): Workspace => ({
  ...workspace(id, paneIds),
  teams: [team(teamId)],
  panes: paneIds.map((paneId) => ({ id: paneId, team: { teamId, role: paneId } })),
});

export const deckState = (partial: Partial<DeckState>): DeckState => ({
  ...initialDeckState,
  ...partial,
});
