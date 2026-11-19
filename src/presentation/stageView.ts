/**
 * What the stage shows over a workspace, decided once.
 *
 * The stage asked this in three places — a workspace with nothing in it
 * rendered a screen of its own, the cards level was a check beside the grid,
 * and the empty-grid word was a third — each spelling its own condition. One
 * answer here, and the stage only draws it:
 *
 * - no team at all: a word saying so — a team is where agents work, and the
 *   sessions a team can continue are shown inside one;
 * - no team open: the team cards;
 * - an open team with somebody on its grid: the grid;
 * - an open team with NOBODY on it, its directory in place: the sessions it
 *   can continue — the way to put its first member on it;
 * - any other open team with an empty grid — every member hidden, or its
 *   directory still being made: the word for that, and — when the team's
 *   Resume would take somebody — the door to ask them back, so a team that
 *   is all down is one press from being all up.
 */
import {
  openTeamOf,
  stagePanes,
  teamsOf,
  type TeamActs,
  type Workspace,
  type WorkspaceView,
} from "../domain/deck";
import { teamResumeLabel } from "./resumeWords";
import { emptyGridMessage } from "./trayView";

export interface StageWord {
  title: string;
  sub: string;
}

export const NO_TEAMS_WORD: StageWord = {
  title: "No teams yet",
  sub: "Start one with “+ Team” — open it, and it lists the sessions it can continue",
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
  | { kind: "cards" }
  | { kind: "grid" }
  | { kind: "team-sessions"; teamId: string; cwd: string }
  | { kind: "word"; word: StageWord; resume: StageResume | null };

/** The empty grid's one act: the open team's Resume, offered exactly when
 * the orchestrator says it would take somebody — the same answer its ⋯
 * offers, in the same words. */
export interface StageResume {
  teamId: string;
  label: string;
}

function stageResume(teamId: string, acts: TeamActs | null): StageResume | null {
  const taking = acts?.resume.take.length ?? 0;
  return taking > 0 ? { teamId, label: teamResumeLabel(taking) } : null;
}

export function stageContent(
  ws: Workspace,
  view: WorkspaceView | undefined,
  /** How many of the open team's panes are live on its grid. */
  liveCount: number,
  /** Whom a team's acts would take right now — the orchestrator's answer. */
  actsOf: (teamId: string) => TeamActs | null,
): StageContent {
  // No team is no team, whatever panes a legacy file still carries: a pane
  // outside every team has no card to be reached from, so the cards level
  // would be a blank stage. The word says what to do instead.
  if (teamsOf(ws).length === 0) return { kind: "no-teams", word: NO_TEAMS_WORD };
  const team = openTeamOf(ws, view);
  if (!team) return { kind: "cards" };
  if (liveCount > 0) return { kind: "grid" };
  const panes = stagePanes(ws, view);
  if (panes.length === 0 && team.location?.kind === "attached") {
    return { kind: "team-sessions", teamId: team.id, cwd: team.location.cwd };
  }
  return { kind: "word", word: emptyGridMessage(panes, view), resume: stageResume(team.id, actsOf(team.id)) };
}
