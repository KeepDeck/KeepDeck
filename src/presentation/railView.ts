/**
 * What the workspaces rail says, decided apart from the markup that draws it
 * — the [`trayView`] and [`teamCardView`] precedent: one row per workspace,
 * in deck order, carrying the name, the status dot and how much is in it.
 *
 * It lived as an inline `.map` in the application controller: three fields
 * and a fallback, reachable only by rendering the whole app. Nothing tested
 * them, and the rail's number is the only answer the app gives to "how much
 * is in that workspace" — the deck bar dropped its own count precisely
 * because this one already answers. Pure and alone it is a table.
 *
 * The dots are folded HERE, from the live activities a single subscription
 * carries in ([`usePaneActivities`]). Twice, and in that order: each team's
 * dot from its own members, then the workspace's from its teams' — max is
 * associative, so the workspace ends up wearing its loudest member's state
 * exactly as it did when the fold read panes directly, and no second table
 * of severities is needed to make the second round agree with the first.
 */
import {
  membersOf,
  teamsOf,
  type Workspace,
  type WorkspaceViewMap,
} from "../domain/deck";
import { workspaceFrame, type PaneActivity, type StatusFrame } from "../domain/status";
import { teamDot, type TeamCardDot } from "./teamCardView";

/** One team under its workspace: the name people address it by and how
 * many agents are on it. What the row is FOR is reaching the team, so it
 * carries the id the way in needs and nothing the card already says
 * better — no branch, no directory, no menu. */
export interface TeamRow {
  id: string;
  name: string;
  size: number;
  /** The team's own dot, ranked once for every surface that draws one. */
  dot: TeamCardDot;
}

/** One row of the rail. */
export interface WorkspaceItem {
  id: string;
  name: string;
  /** How many teams the workspace holds — what the row's number says.
   * A team is the deck's unit of placement, so "how much is in there" is
   * answered in teams; how many agents are on one is the team's own row
   * to say. */
  teamCount: number;
  /** The workspace's teams in deck order — the rows under its name. Same
   * order the cards level lays them out in, so the two surfaces never
   * disagree about which team is which. Carried whether or not they are
   * shown: whether to show them is the row's own question, and a row that
   * had to be re-derived to answer it would answer it differently. */
  teams: readonly TeamRow[];
  /** Whether the rail is listing this workspace's teams right now. */
  expanded: boolean;
  /** The workspace's status frame, folded by the domain ladder — the dot
   * paints it verbatim. Absent = the plain gray dot. */
  dot?: StatusFrame;
}

/**
 * Every workspace the deck holds, in its order — a workspace is never
 * omitted, whatever is or is not inside it: the rail is how the person
 * reaches one, so a row that disappears takes the way back with it.
 *
 * A workspace with no folded frame wears `"none"`, the same bare gray dot
 * the frame itself means, so the row's shape does not depend on whether the
 * tracker has heard of it yet.
 */
export function railView(
  workspaces: readonly Workspace[],
  activities: ReadonlyMap<string, PaneActivity>,
  viewByWs: WorkspaceViewMap,
  activeId: string,
): WorkspaceItem[] {
  return workspaces.map((ws) => {
    const teams = teamsOf(ws).map((team) => {
      const members = membersOf(ws, team.id);
      return {
        id: team.id,
        name: team.name,
        size: members.length,
        dot: teamDot(
          team,
          members.map((pane) => activities.get(pane.id)),
        ),
      };
    });
    return {
      id: ws.id,
      name: ws.name,
      teamCount: teams.length,
      teams,
      // A workspace with nothing to list is never "expanded": the chevron
      // has nothing to turn, and a row that claimed to be open while
      // showing nothing would be a promise it cannot keep.
      expanded: teams.length > 0 && (viewByWs[ws.id]?.railExpanded ?? false),
      dot: workspaceFrame(teams.map((team) => workspaceState(team.dot)), ws.id === activeId),
    };
  });
}

/**
 * A team's rung as the workspace's own ladder ranks it. Two of the team's
 * six have no place there and are answered here rather than by a second
 * table of severities:
 *
 * - `creating` collapses to nothing, the way the card already collapses
 *   `selected`. The card can afford to say "a directory is on its way" —
 *   it has a pending rim beside the dot and room to be read slowly. A rail
 *   dot is seven pixels of peripheral vision, and the app already decided
 *   this state must never read as the person's turn.
 * - a failed CREATE is the workspace's `failed`, loud as any failed turn:
 *   until it is retried nothing on that team can run at all, which is the
 *   one thing about a background workspace worth interrupting for.
 */
function workspaceState(dot: TeamCardDot): PaneActivity["state"] | undefined {
  return dot === "creating" || dot === "none" ? undefined : dot;
}
