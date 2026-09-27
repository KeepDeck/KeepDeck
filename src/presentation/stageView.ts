/**
 * What the stage shows over a workspace, decided once.
 *
 * One answer here, and the stage only draws it. The stage always shows a
 * team — the one opened, else the first (`openTeamOf`) — so:
 *
 * - no team at all: a word saying so — a team is where agents work, and the
 *   sessions a team can continue are shown inside one;
 * - an open team with somebody on its grid: the grid;
 * - an open team with NOBODY on it, its directory in place: the sessions it
 *   can continue — the way to put its first member on it;
 * - any other open team with an empty grid — every member hidden, or its
 *   directory still being made: the word for that.
 */
import { openTeamOf, stagePanes, type Workspace, type WorkspaceView } from "../domain/deck";
import { emptyGridMessage } from "./trayView";

export interface StageWord {
  title: string;
  sub: string;
}

export const NO_TEAMS_WORD: StageWord = {
  title: "No teams yet",
  sub: "Start one with “+” beside the teams list — it lists the sessions it can continue",
};

/** The empty team's sessions list — the words over it. */
export const TEAM_SESSIONS_WORDS = {
  title: "Nobody on this team yet",
  /** Resume or Fork pressed before a role is picked. */
  pickFirst: "Pick a role first — nothing is chosen for it",
} as const;

/** The line under the empty team's role picker: the address a pick takes,
 * the error once Resume or Fork was pressed without one — or nothing,
 * the header stays one line. */
export type TeamSessionsHint = { kind: "address"; address: string } | { kind: "error"; text: string } | null;

export function teamSessionsHint(
  address: string | null,
  /** Resume or Fork was pressed with no role picked. */
  askedWithout: boolean,
): TeamSessionsHint {
  if (address !== null) return { kind: "address", address };
  return askedWithout ? { kind: "error", text: TEAM_SESSIONS_WORDS.pickFirst } : null;
}

export type StageContent =
  | { kind: "no-teams"; word: StageWord }
  | { kind: "grid" }
  | { kind: "team-sessions"; teamId: string; cwd: string }
  | { kind: "word"; word: StageWord };

export function stageContent(
  ws: Workspace,
  view: WorkspaceView | undefined,
  /** How many of the open team's panes are live on its grid. */
  liveCount: number,
): StageContent {
  const team = openTeamOf(ws, view);
  if (!team) return { kind: "no-teams", word: NO_TEAMS_WORD };
  if (liveCount > 0) return { kind: "grid" };
  const panes = stagePanes(ws, view);
  if (panes.length === 0 && team.location?.kind === "attached") {
    return { kind: "team-sessions", teamId: team.id, cwd: team.location.cwd };
  }
  return { kind: "word", word: emptyGridMessage(panes, view) };
}
