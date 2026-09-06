/**
 * What a team's card says, decided apart from the markup that draws it.
 *
 * A card is six things and no more: a dot, the name, the ⋯ menu, the
 * branch, how many agents, and the directory. No agent statuses, no
 * terminal tail, no error text, no buttons — those live inside the team
 * and in the menu (the one decision the prototype rounds settled). One
 * anatomy for every state: a team whose directory is still being created,
 * or whose create failed, wears the same card with a different dot and a
 * pending rim, and a team of one is a team like any other — nothing here
 * asks how many members there are except to print the number.
 *
 * The ACTIONS are described, not performed (the `trayView` precedent): the
 * stage turns each into the callback it owns. One set on every card, plus
 * Retry when the create failed — the one thing a card offers that depends
 * on its state, and it is in the menu, never on the card.
 *
 * The dot is the rail's own ladder folded over the members
 * (`workspaceFrame`), with the two states only a team has slotted in:
 *
 *   failed › waiting › tree failed › creating › working › done › none
 *
 * A member needing the person outranks a directory that is not there —
 * the person can answer now, and the create is nothing to answer — and a
 * failed create outranks any quieter member, because until it is retried
 * nothing on the team can work.
 */
import {
  membersOf,
  teamHeldPath,
  type GitPosition,
  type Team,
  type Workspace,
} from "../domain/deck";
import { workspaceFrame, type PaneActivity } from "../domain/status";

export type TeamCardDot =
  | "failed"
  | "waiting"
  | "creating"
  | "working"
  | "done"
  | "none";

export type TeamCardAction = "add-member" | "rename" | "disband" | "retry";

/** The menu every card carries, in the order it is offered. Opening is not
 * in it: the whole card is the way in, and a menu line saying so again was
 * a line the person had to read past. */
const EVERY_CARD: readonly TeamCardAction[] = ["add-member", "rename", "disband"];

export interface TeamCardView {
  id: string;
  name: string;
  /** The branch the team works on — the live head's when one is known,
   * else the one on record, or the one its create is heading for. Null
   * for a directory with no branch to speak of. */
  branch: string | null;
  /** Where the team works: its directory, or the path its create is
   * heading for. */
  cwd: string;
  /** How many agents are on it. */
  size: number;
  dot: TeamCardDot;
  /** Whether the directory is not there yet — creating, or the create
   * failed. The card's rim says so; the dot says which. */
  pending: boolean;
  actions: readonly TeamCardAction[];
}

/** The branch a team works on, as every surface says it: the live head's
 * when one is known, else the one on record, or the one its create is
 * heading for. Null for a directory with no branch to speak of. */
export function teamBranchOf(team: Team, head?: GitPosition): string | null {
  const location = team.location;
  if (location?.kind === "provisioning") return location.intent.branch ?? null;
  return head?.branch ?? (location?.kind === "attached" ? location.branch : undefined) ?? null;
}

export function teamCardView(
  ws: Workspace,
  team: Team,
  /** The members' live activity, in any order; absent entries are fine. */
  activities: Iterable<PaneActivity | undefined>,
  /** The live git head at the team's directory, when the app has read one. */
  head?: GitPosition,
): TeamCardView {
  const location = team.location;
  const creating = location?.kind === "provisioning";
  const treeFailed = creating && location.error !== undefined;
  // `selected: false` — a card is picked out by nothing but its own dot,
  // like a rail dot on a background workspace.
  const frame = workspaceFrame(activities, false);
  const dot: TeamCardDot =
    frame === "failed" || frame === "waiting"
      ? frame
      : treeFailed
        ? "failed"
        : creating
          ? "creating"
          : frame === "selected"
            ? "none"
            : frame;
  return {
    id: team.id,
    name: team.name,
    branch: teamBranchOf(team, head),
    cwd: teamHeldPath(team) ?? ws.cwd,
    size: membersOf(ws, team.id).length,
    dot,
    pending: creating,
    actions: treeFailed ? [...EVERY_CARD, "retry"] : EVERY_CARD,
  };
}
