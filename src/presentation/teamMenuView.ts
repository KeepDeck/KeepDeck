/**
 * A team's ⋯ menu — ONE line-set for the card's menu and the team crumb's,
 * so the two can never offer, order, word or refuse a line differently.
 *
 * Every line is always there. One that cannot act right now is disabled,
 * with the reason drawn under it — never dropped, so the menu does not
 * change shape under the person's hand. Whom Resume and Suspend would take
 * is the orchestrator's answer (`TeamActs`), the very one its doors act on;
 * what Add member, Disband and Retry would meet is the machine's, carried in
 * the same answer. This file only words them.
 */
import {
  createFailed,
  memberRefusal,
  type Team,
  type TeamActs,
  type Workspace,
} from "../domain/deck";
import type { Refusal, TeamGates } from "../domain/lifecycle";
import { refusalText } from "./lifecycleWords";
import { teamResumeOffer, teamResumeRefusalText, type TeamResumeRefusal } from "./resumeWords";
import { teamSuspendRefusalText } from "./suspendWords";

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
  /** Both act lines' refusal for a team with nobody on it — a fact about
   * the team, not a reason of either act. */
  noAgents: "This team has no agents.",
  /** Both act lines' refusal while a member is still on its way up or down
   * — the team's, so both say the same. */
  settling: "An agent on this team is still starting or stopping.",
  /** The ⋯ as a screen reader names it, on either surface. */
  ariaLabel: (name: string) => `Team ${name} actions`,
  /** The field its Rename line opens, on either surface. */
  renameField: "Rename team",
} as const;

function resumeLine(acts: TeamActs["resume"]): Pick<TeamMenuItem, "label" | "refusal"> {
  const offer = teamResumeOffer(acts);
  // The menu keeps the line when there is nothing to offer — refused, in
  // its own name, saying why.
  return offer !== null
    ? { label: offer, refusal: null }
    : { label: TEAM_MENU_WORDS.label.resume, refusal: resumeRefusal(acts.skip) };
}

function resumeRefusal(whys: TeamActs["resume"]["skip"]): string {
  if (whys.length === 0) return TEAM_MENU_WORDS.noAgents;
  if (whys.includes("settling")) return TEAM_MENU_WORDS.settling;
  return teamResumeRefusalText(resumeReason(whys));
}

/** Which reason a team's Resume refusal gives: one the whole team shares
 * first, then whether anybody is down at all, then why those who are
 * cannot come back. */
function resumeReason(whys: TeamActs["resume"]["skip"]): TeamResumeRefusal {
  if (whys.includes("archived")) return { kind: "archived" };
  if (whys.includes("provisioning")) return { kind: "provisioning" };
  // Down, but not something Resume can bring back: its folder is gone, it
  // runs on a server, or no installed agent can start it.
  const stuck = whys.filter((why) => why === "blocked" || why === "remote" || why === "unavailable");
  if (stuck.length === 0) return { kind: "none-stopped" };
  const gone = stuck.filter((why) => why === "blocked").length;
  return gone === stuck.length ? { kind: "folders-gone", count: gone } : { kind: "none-resumable" };
}

/** The machine's refusal of a shut gate, in its words; null for an open
 * one, or before the machine has said. */
function gateRefusal(refusal: Refusal | null | undefined): string | null {
  return refusal ? refusalText(refusal) : null;
}

/**
 * Why a member cannot be added to this team now — what the machine's gate
 * says first (it is leaving, its workspace is archived), then the cap. The
 * menu's line and the deck bar's door both say it, in the same words.
 */
export function addMemberRefusal(ws: Pick<Workspace, "panes">, teamId: string, gates: TeamGates | null): string | null {
  return gateRefusal(gates?.addMember) ?? memberRefusal(ws, teamId);
}

function suspendRefusal(acts: TeamActs["suspend"]): string | null {
  if (acts.take.length > 0) return null;
  const whys = acts.skip;
  if (whys.length === 0) return TEAM_MENU_WORDS.noAgents;
  if (whys.includes("settling")) return TEAM_MENU_WORDS.settling;
  // A reason the whole team shares first, then one only some hold.
  const reason = (["provisioning", "in-flight", "remote"] as const).find((why) => whys.includes(why)) ?? "stopped";
  return teamSuspendRefusalText(reason);
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
        return { action, label: TEAM_MENU_WORDS.label[action], refusal: addMemberRefusal(ws, team.id, acts.gates) };
      case "disband":
        return { action, label: TEAM_MENU_WORDS.label[action], refusal: gateRefusal(acts.gates?.close) };
      case "retry":
        return { action, label: TEAM_MENU_WORDS.label[action], refusal: gateRefusal(acts.gates?.retry) };
      case "rename":
        return { action, label: TEAM_MENU_WORDS.label[action], refusal: null };
    }
  };
  const actions = createFailed(team.location) ? [...ORDER[surface], "retry" as const] : ORDER[surface];
  return actions.map(line);
}
