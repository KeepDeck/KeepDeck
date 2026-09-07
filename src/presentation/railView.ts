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
 * The dot arrives already folded rather than folded here: the fold reads
 * live status, which is a subscription's business ([`useWorkspaceFrames`]
 * holds the rail's one subscription), and a projection that took the tracker
 * would carry it into every test that only wanted to know what a row says.
 */
import {
  membersOf,
  teamsOf,
  type Workspace,
  type WorkspaceViewMap,
} from "../domain/deck";
import type { StatusFrame } from "../domain/status";

/** One team under its workspace: the name people address it by and how
 * many agents are on it. What the row is FOR is reaching the team, so it
 * carries the id the way in needs and nothing the card already says
 * better — no branch, no directory, no menu. */
export interface TeamRow {
  id: string;
  name: string;
  size: number;
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
  frames: ReadonlyMap<string, StatusFrame>,
  viewByWs: WorkspaceViewMap,
): WorkspaceItem[] {
  return workspaces.map((ws) => {
    const teams = teamsOf(ws).map((team) => ({
      id: team.id,
      name: team.name,
      size: membersOf(ws, team.id).length,
    }));
    return {
      id: ws.id,
      name: ws.name,
      teamCount: teams.length,
      teams,
      // A workspace with nothing to list is never "expanded": the chevron
      // has nothing to turn, and a row that claimed to be open while
      // showing nothing would be a promise it cannot keep.
      expanded: teams.length > 0 && (viewByWs[ws.id]?.railExpanded ?? false),
      dot: frames.get(ws.id) ?? "none",
    };
  });
}
