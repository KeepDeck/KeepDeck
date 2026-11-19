/**
 * A team's ⋯ menu — ONE line-set for the card's menu and the team crumb's,
 * so the two can never offer, order, word or refuse a line differently.
 *
 * Every line is always there. One that cannot act right now is disabled,
 * with the reason drawn under it — never dropped, so the menu does not
 * change shape under the person's hand. Whom Resume and Suspend would take
 * is the orchestrator's answer (`TeamActs`), the very one its doors act on;
 * this file only words it.
 */
import {
  createFailed,
  memberRefusal,
  type Team,
  type TeamActs,
  type Workspace,
} from "../domain/deck";
import { byCount, counted } from "./countWords";
import { resumeRefusalText } from "./resumeWords";
import { suspendRefusalText } from "./suspendWords";

export type TeamMenuAction = "add-member" | "rename" | "resume" | "suspend" | "disband" | "retry";

/** Which ⋯ the lines are for. The card leads with what the team is — its
 * members, its name; the crumb is already inside the team, and leads with
 * what its agents are doing. */
export type TeamMenuSurface = "card" | "crumb";

export interface TeamMenuItem {
  action: TeamMenuAction;
  label: string;
  /** Why the line cannot act right now; null when it can. */
  refusal: string | null;
}

/** The lines each surface offers, in order. Retry joins last, and only
 * after a failed create — the one line that depends on the team's state. */
const ORDER: Record<TeamMenuSurface, readonly TeamMenuAction[]> = {
  card: ["add-member", "rename", "resume", "suspend", "disband"],
  crumb: ["resume", "suspend", "add-member", "rename", "disband"],
};

/** Every word a team's menu says. */
export const TEAM_MENU_WORDS = {
  label: {
    "add-member": "Add member",
    rename: "Rename",
    /** Resume with nobody to take; with someone, the line counts them. */
    resume: "Resume team",
    suspend: "Suspend team",
    disband: "Disband",
    retry: "Retry the worktree",
  } satisfies Record<TeamMenuAction, string>,
  /** The team as the single-pane refusals name their subject — a reason
   * the whole team shares is said in the single act's own sentence. */
  subject: "This team",
  noAgents: "This team has no agents.",
  noneStopped: "No agent on this team is stopped.",
  noneResumable: "No stopped agent can be resumed right now.",
  foldersGone: (n: number) =>
    `No stopped agent can be resumed — ${byCount(n, "its folder is gone", "their folders are gone")}.`,
  noneRunning: "Nothing on this team is running.",
  runningRemote: "Its running agents run on a remote server — stopping the local client would not park them.",
  /** The ⋯ as a screen reader names it, on either surface. */
  ariaLabel: (name: string) => `Team ${name} actions`,
  /** The field its Rename line opens, on either surface. */
  renameField: "Rename team",
} as const;

function resumeLine(acts: TeamActs["resume"]): Pick<TeamMenuItem, "label" | "refusal"> {
  const n = acts.take.length;
  if (n > 0) return { label: `Resume ${counted(n, "stopped agent")}`, refusal: null };
  return { label: TEAM_MENU_WORDS.label.resume, refusal: resumeRefusal(acts.skip) };
}

function resumeRefusal(whys: TeamActs["resume"]["skip"]): string {
  if (whys.length === 0) return TEAM_MENU_WORDS.noAgents;
  if (whys.includes("archived")) return resumeRefusalText("archived", TEAM_MENU_WORDS.subject);
  if (whys.includes("provisioning")) return resumeRefusalText("provisioning", TEAM_MENU_WORDS.subject);
  // Down, but not something Resume can bring back: its folder is gone, it
  // runs on a server, or no installed agent can start it.
  const stuck = whys.filter((why) => why === "blocked" || why === "remote" || why === "unavailable");
  if (stuck.length === 0) return TEAM_MENU_WORDS.noneStopped;
  const gone = stuck.filter((why) => why === "blocked").length;
  return gone === stuck.length ? TEAM_MENU_WORDS.foldersGone(gone) : TEAM_MENU_WORDS.noneResumable;
}

function suspendRefusal(acts: TeamActs["suspend"]): string | null {
  if (acts.take.length > 0) return null;
  const whys = acts.skip;
  if (whys.length === 0) return TEAM_MENU_WORDS.noAgents;
  if (whys.includes("provisioning")) return suspendRefusalText("provisioning", TEAM_MENU_WORDS.subject);
  if (whys.includes("in-flight")) return suspendRefusalText("in-flight", TEAM_MENU_WORDS.subject);
  return whys.includes("remote") ? TEAM_MENU_WORDS.runningRemote : TEAM_MENU_WORDS.noneRunning;
}

/** The lines of a team's ⋯ on `surface`, each with its refusal — none
 * for a team the orchestrator no longer holds (`acts` null). */
export function teamMenuView(
  ws: Workspace,
  team: Pick<Team, "id" | "location">,
  acts: TeamActs | null,
  surface: TeamMenuSurface,
): TeamMenuItem[] {
  if (!acts) return [];
  const line = (action: TeamMenuAction): TeamMenuItem => {
    switch (action) {
      case "resume":
        return { action, ...resumeLine(acts.resume) };
      case "suspend":
        return { action, label: TEAM_MENU_WORDS.label.suspend, refusal: suspendRefusal(acts.suspend) };
      case "add-member":
        // A full team refuses in the cap's own message, the one every door
        // says it with.
        return { action, label: TEAM_MENU_WORDS.label[action], refusal: memberRefusal(ws, team.id) };
      case "rename":
      case "disband":
      case "retry":
        return { action, label: TEAM_MENU_WORDS.label[action], refusal: null };
    }
  };
  const actions = createFailed(team.location) ? [...ORDER[surface], "retry" as const] : ORDER[surface];
  return actions.map(line);
}
