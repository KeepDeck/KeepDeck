/**
 * What every surface says about ONE team, decided once: its dot, its
 * branch, and what can be done to it. The left strip's row, the bar's
 * crumb and the row's menu all read here, so no two of them rank a team's
 * state or offer its actions their own way.
 *
 * The dot is the pane ladder folded over the members (`foldFrame`), with
 * the two states only a team has slotted in:
 *
 *   failed › waiting › tree failed › creating › working › done › none
 *
 * A member needing the person outranks a directory that is not there —
 * the person can answer now, and the create is nothing to answer — and a
 * failed create outranks any quieter member, because until it is retried
 * nothing on the team can work.
 *
 * The ACTIONS are described, not performed (the `trayView` precedent): the
 * surface turns each into the callback it owns. One set for every team,
 * plus Retry when the create failed — the one action that depends on the
 * team's state.
 */
import { createFailed, type GitPosition, type Team } from "../domain/deck";
import { foldFrame, type PaneActivity } from "../domain/status";

export type TeamDot = "failed" | "waiting" | "creating" | "working" | "done" | "none";

export type TeamAction = "add-member" | "rename" | "disband" | "retry";

/** The menu every team carries, in the order it is offered. Opening is not
 * in it: the row itself is the way in. */
const EVERY_TEAM: readonly TeamAction[] = ["add-member", "rename", "disband"];

/** Every word said about a team outside its own stage. */
export const TEAM_WORDS = {
  /** The menu's line for each action. */
  action: {
    "add-member": "Add member",
    rename: "Rename",
    disband: "Disband",
    retry: "Retry the worktree",
  } satisfies Record<TeamAction, string>,
  /** The ⋯ menu as a screen reader names it. */
  menu: (name: string) => `Team ${name} actions`,
  /** How many agents are on the team. */
  agents: (size: number) => (size === 0 ? "No agents" : `${size} agent${size === 1 ? "" : "s"}`),
  renameField: "Rename team",
} as const;

/** The branch a team works on, as every surface says it: the live head's
 * when one is known, else the one on record, or the one its create is
 * heading for. Null for a directory with no branch to speak of. */
export function teamBranchOf(team: Team, head?: GitPosition): string | null {
  const location = team.location;
  if (location?.kind === "provisioning") return location.intent.branch ?? null;
  return head?.branch ?? (location?.kind === "attached" ? location.branch : undefined) ?? null;
}

/** A team's dot — the ladder at the top of this file, and the one place it
 * is decided. */
export function teamDot(
  team: Pick<Team, "location">,
  /** The members' live activity, in any order; absent entries are fine. */
  activities: Iterable<PaneActivity | undefined>,
): TeamDot {
  const location = team.location;
  const creating = location?.kind === "provisioning";
  const treeFailed = createFailed(location);
  const frame = foldFrame([...activities].map((activity) => activity?.state));
  return frame === "failed" || frame === "waiting"
    ? frame
    : treeFailed
      ? "failed"
      : creating
        ? "creating"
        : frame;
}

/** Whether the team's directory is not there yet — creating, or the create
 * failed. */
export function teamPending(team: Pick<Team, "location">): boolean {
  return team.location?.kind === "provisioning";
}

/** What can be done to the team, in menu order. */
export function teamActions(team: Pick<Team, "location">): readonly TeamAction[] {
  return createFailed(team.location) ? [...EVERY_TEAM, "retry"] : EVERY_TEAM;
}
