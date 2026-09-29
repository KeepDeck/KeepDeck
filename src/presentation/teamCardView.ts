/**
 * What a team's card says, decided apart from the markup that draws it.
 *
 * A card is seven things and no more: a dot, the name, the ⋯ menu, the
 * branch, how many agents, the directory, and one line about the team's
 * tasks when it has any. No agent statuses, no
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
 * The dot is the pane ladder folded over the members
 * (`foldFrame`), with the two states only a team has slotted in:
 *
 *   failed › waiting › tree failed › creating › working › done › none
 *
 * A member needing the person outranks a directory that is not there —
 * the person can answer now, and the create is nothing to answer — and a
 * failed create outranks any quieter member, because until it is retried
 * nothing on the team can work.
 */
import {
  baseName,
  createFailed,
  memberRefusal,
  membersOf,
  teamHeldPath,
  teamsOf,
  type GitPosition,
  type Team,
  type Workspace,
} from "../domain/deck";
import { foldFrame, type PaneActivity } from "../domain/status";
import { tasksOfTeam, type Task, type TaskBoard } from "../domain/tasks";
import { teamCardTasksLine } from "./tasks/teamCardTasksLine";

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

/** Every word a team card says — the card maps, it never spells. */
export const TEAM_CARD_WORDS = {
  /** The menu's line for each action. */
  action: {
    "add-member": "Add member",
    rename: "Rename",
    disband: "Disband",
    retry: "Retry the worktree",
  } satisfies Record<TeamCardAction, string>,
  /** The dot's tooltip, and what a screen reader says for it. */
  dot: {
    failed: "Needs attention",
    waiting: "Waiting for you",
    creating: "Creating the worktree",
    working: "Working",
    done: "Done",
    none: "Idle",
  } satisfies Record<TeamCardDot, string>,
  /** The card as a screen reader names it. */
  card: (name: string) => `Team ${name}`,
  /** The ⋯ menu as a screen reader names it. */
  menu: (name: string) => `Team ${name} actions`,
  /** How many agents are on the team. */
  agents: (size: number) => (size === 0 ? "No agents" : `${size} agent${size === 1 ? "" : "s"}`),
  renameField: "Rename team",
  openHint: "Open the team — double-click to rename",
} as const;

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
  /** The directory's last segment — what the card prints; `cwd` is its
   * tooltip. */
  dir: string;
  /** The card's line about its board, or null for a team with no tasks
   * (or while the board is not read). */
  tasksLine: string | null;
  /** The card's classes: its dot's tone, and the pending rim. */
  className: string;
  actions: readonly TeamCardAction[];
  /** Why an offered action is refused right now, by action — the menu
   * shows it disabled with these words. A full team refuses a member in
   * the cap's own message, the one every door says it with. */
  refusals: Partial<Record<TeamCardAction, string>>;
}

/** The branch a team works on, as every surface says it: the live head's
 * when one is known, else the one on record, or the one its create is
 * heading for. Null for a directory with no branch to speak of. */
export function teamBranchOf(team: Team, head?: GitPosition): string | null {
  const location = team.location;
  if (location?.kind === "provisioning") return location.intent.branch ?? null;
  return head?.branch ?? (location?.kind === "attached" ? location.branch : undefined) ?? null;
}

/**
 * A team's dot — the ladder at the top of this file, and the one place it
 * is decided. The card draws it big beside a pending rim; the strip folds
 * the teams into its workspace mark; neither may rank these states its own way.
 */
export function teamDot(
  team: Pick<Team, "location">,
  /** The members' live activity, in any order; absent entries are fine. */
  activities: Iterable<PaneActivity | undefined>,
): TeamCardDot {
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

/** The live git head at a team's directory — the one answer to "which
 * head belongs to this team", for the card and the bar alike. */
export function teamHead(
  ws: Pick<Workspace, "cwd">,
  team: Team,
  heads: ReadonlyMap<string, GitPosition>,
): GitPosition | undefined {
  return heads.get(teamHeldPath(team) ?? ws.cwd);
}

/** Every card of a workspace, in deck order. */
export function teamCardsView(
  ws: Workspace,
  /** Live activity by pane — the tracker's snapshot. */
  activities: ReadonlyMap<string, PaneActivity>,
  heads: ReadonlyMap<string, GitPosition>,
  /** The workspace's task board, or null while it is not read. */
  board: TaskBoard | null,
): TeamCardView[] {
  return teamsOf(ws).map((team) =>
    teamCardView(
      ws,
      team,
      membersOf(ws, team.id).map((pane) => activities.get(pane.id)),
      teamHead(ws, team, heads),
      board ? tasksOfTeam(board, team.id) : null,
    ),
  );
}

export function teamCardView(
  ws: Workspace,
  team: Team,
  /** The members' live activity, in any order; absent entries are fine. */
  activities: Iterable<PaneActivity | undefined>,
  /** The live git head at the team's directory, when the app has read one. */
  head?: GitPosition,
  /** The team's tasks, or null while the board is not read. */
  tasks: readonly Task[] | null = null,
): TeamCardView {
  const location = team.location;
  const creating = location?.kind === "provisioning";
  const treeFailed = createFailed(location);
  const dot = teamDot(team, activities);
  const cwd = teamHeldPath(team) ?? ws.cwd;
  return {
    id: team.id,
    name: team.name,
    branch: teamBranchOf(team, head),
    cwd,
    size: membersOf(ws, team.id).length,
    dot,
    pending: creating,
    dir: baseName(cwd),
    tasksLine: tasks ? teamCardTasksLine(tasks) : null,
    className: `team-card team-card--${dot}${creating ? " team-card--pending" : ""}`,
    actions: treeFailed ? [...EVERY_CARD, "retry"] : EVERY_CARD,
    refusals: refusalsFor(ws, team),
  };
}

function refusalsFor(ws: Workspace, team: Team): Partial<Record<TeamCardAction, string>> {
  const full = memberRefusal(ws, team.id);
  return full === null ? {} : { "add-member": full };
}
