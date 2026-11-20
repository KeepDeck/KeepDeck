/**
 * The Workspaces page's Worktrees table — every checkout of the workspace's
 * repository, from `git worktree list`, and who holds each: decided apart
 * from the markup.
 *
 * Who holds a folder is the lifecycle machine's answer (`lifecycle_claims`),
 * over EVERY workspace, archived ones included: an archive keeps its
 * directories. The deck only names the team a claim points at. Only a
 * checkout nobody holds offers Remove — a held one names its holder, and is
 * closed with its team.
 */
import { baseName, findTeamInDeck, normalizePath, sameDirectory, type RepoCheckout, type Workspace } from "../domain/deck";
import { claimingTeams, type Claim, type IntentOutcome } from "../domain/lifecycle";
import { byCount, counted } from "./countWords";
import { intentOutcomeText } from "./lifecycleWords";

export const WORKTREE_WORDS = {
  title: "Worktrees",
  /** Said only while a row can be removed. */
  hint: "A worktree no team uses can be removed here. Its branch is kept.",
  newTeam: "New team in a worktree",
  loading: "Reading the repository's worktrees…",
  notARepo: "Not a git repository — it has no worktrees.",
  columns: { folder: "Folder", branch: "Branch", holder: "Held by", state: "State" },
  remove: "Remove",
  openTeam: "Open team",
  clean: "clean",
  unknownChanges: "unknown",
  gone: "folder gone",
  locked: "locked",
  free: "no team",
  root: "workspace folder",
  creating: "being created",
  removing: "being removed",
} as const;

export interface WorktreeRowView {
  /** The full path — what the folder column shortens. */
  path: string;
  /** The folder as the column shows it: the repository by its name, a
   * checkout beside it relative to the folder they share, any other in full. */
  folder: string;
  /** The branch, or the detached commit it stands on. */
  branch: string;
  detached: boolean;
  /** Who holds it, in words, and what kind of holder that is. */
  holder: string;
  /** `busy`: a worktree is being made or removed there. */
  holderKind: "root" | "team" | "busy" | "free";
  /** A team the person can open from the row: one of a workspace in use. */
  team: { wsId: string; teamId: string } | null;
  /** What is in it, in words, and what kind of state that is. */
  state: string;
  stateKind: "clean" | "changed" | "unknown" | "gone";
  /** Offered only for a checkout nobody holds, whose folder is there. */
  removable: boolean;
}

export interface WorktreeTableView {
  rows: WorktreeRowView[];
  /** Whether any row has something to do — the acts column is drawn only
   * then, so an empty one never takes the table's width. */
  acts: boolean;
  /** Whether any row can be removed — the hint about removing is said only
   * then. */
  removable: boolean;
}

/** The folder a column shows for `path`: the repository by its own name, a
 * checkout in the folder beside it (where worktrees usually go) relative to
 * that folder, anything else in full. */
export function worktreeFolder(path: string, repo: string): string {
  if (sameDirectory(path, repo)) return baseName(repo) || repo;
  const root = normalizePath(repo);
  const parent = root.slice(0, root.lastIndexOf("/"));
  const at = normalizePath(path);
  return parent !== "" && at.startsWith(`${parent}/`) ? at.slice(parent.length + 1) : at;
}

type Holder = Pick<WorktreeRowView, "holder" | "holderKind" | "team">;

/** Who holds `path`: a workspace's own folder, the machine's word on it — a
 * worktree being made or removed there, a team (here, or in another
 * workspace — an archived one said so) — or nobody. */
function holderOf(path: string, claims: readonly Claim[], workspace: Workspace, workspaces: readonly Workspace[]): Holder {
  const roots = workspaces.filter((ws) => sameDirectory(ws.cwd, path));
  if (roots.length > 0) {
    const elsewhere = roots.filter((ws) => ws.id !== workspace.id).map((ws) => ws.name);
    return {
      holder: roots.some((ws) => ws.id === workspace.id) ? WORKTREE_WORDS.root : `${WORKTREE_WORDS.root} · ${elsewhere.join(", ")}`,
      holderKind: "root",
      team: null,
    };
  }
  if (claims.some((claim) => claim.kind === "creation")) return { holder: WORKTREE_WORDS.creating, holderKind: "busy", team: null };
  if (claims.some((claim) => claim.kind === "removal")) return { holder: WORKTREE_WORDS.removing, holderKind: "busy", team: null };
  const holding = claimingTeams(claims)
    .map((teamId) => findTeamInDeck(workspaces, teamId))
    .find((found) => found !== undefined);
  if (!holding) return { holder: WORKTREE_WORDS.free, holderKind: "free", team: null };
  const here = holding.workspace.id === workspace.id;
  return {
    holder: here
      ? holding.team.name
      : `${holding.team.name} · ${holding.workspace.name}${holding.workspace.archived ? " (archived)" : ""}`,
    holderKind: "team",
    team: holding.workspace.archived ? null : { wsId: holding.workspace.id, teamId: holding.team.id },
  };
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "?");

function stateOf(row: RepoCheckout): Pick<WorktreeRowView, "state" | "stateKind"> {
  const [state, stateKind]: [string, WorktreeRowView["stateKind"]] = row.prunable
    ? [WORKTREE_WORDS.gone, "gone"]
    : row.changed === null
      ? [WORKTREE_WORDS.unknownChanges, "unknown"]
      : row.changed === 0
        ? [WORKTREE_WORDS.clean, "clean"]
        : [`${row.changed} uncommitted`, "changed"];
  return { state: row.locked ? `${state} · ${WORKTREE_WORDS.locked}` : state, stateKind };
}

/** The table of the listed checkouts, `claimsOf` giving the machine's
 * claims on each — none for a path it was not asked about. */
export function worktreeTableView(
  listed: readonly RepoCheckout[],
  claimsOf: (path: string) => readonly Claim[],
  workspace: Workspace,
  workspaces: readonly Workspace[],
): WorktreeTableView {
  const rows = listed.map((row): WorktreeRowView => {
      const holder = holderOf(row.path, claimsOf(row.path), workspace, workspaces);
      return {
        path: row.path,
        folder: worktreeFolder(row.path, workspace.cwd),
        branch: row.branch ?? short(row.head),
        detached: row.branch === null,
        ...holder,
        ...stateOf(row),
        removable: holder.holderKind === "free" && !row.prunable && !row.locked,
      };
    });
  return {
    rows,
    acts: rows.some((row) => row.team !== null || row.removable),
    removable: rows.some((row) => row.removable),
  };
}

/** A ref name part git takes whatever the name held: only letters, digits,
 * dashes and underscores — no dot, so never "..", a leading "." or a
 * trailing ".lock". */
const refSafe = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";

/** The tag a detached checkout's commit is kept under before it goes. */
export function keptHeadName(workspace: Workspace, path: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `archive/${refSafe(workspace.name)}/${refSafe(baseName(path))}-${day}`;
}

/** What asking for a removal did, said after it: under way — the commit
 * kept first under the tag asked for, if one was — or the machine's
 * refusal. How the removal itself ends is the lifecycle's notice. */
export function unheldRemovalWords(outcome: IntentOutcome, keptAs: string | undefined): string {
  if (outcome.kind !== "accepted") {
    return outcome.kind === "refused" && outcome.refusal.kind === "busy"
      ? "Something holds it now, so it was left as it is."
      : (intentOutcomeText(outcome) ?? "");
  }
  return keptAs ? `Removing it. Its commit is kept as ${keptAs}.` : "Removing it.";
}

export interface WorktreeRemovalConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  /** The person agrees to lose uncommitted work by confirming. */
  discardDirty: boolean;
  /** Keep the detached commit as this tag first. */
  keepHeadAs?: string;
}

/** What the person is asked before a checkout nobody holds goes. */
export function worktreeRemovalConfirm(
  row: RepoCheckout,
  workspace: Workspace,
  now: number,
): WorktreeRemovalConfirm {
  const changed = row.changed ?? 0;
  const keepHeadAs = row.detached && row.head ? keptHeadName(workspace, row.path, now) : undefined;
  const lines = [
    changed > 0
      ? `Its ${counted(changed, "changed entry", "changed entries")} ${byCount(changed, "is", "are")} lost with the folder, and so are any ignored files in it.`
      : "Its folder is deleted, ignored files in it included.",
    keepHeadAs
      ? `It stands on no branch: its commit ${short(row.head)} is kept as the tag ${keepHeadAs}.`
      : `Its branch ${row.branch ?? ""} stays, with every commit on it.`,
  ];
  return {
    title: `Remove the worktree “${baseName(row.path)}”?`,
    message: lines.join("\n\n"),
    confirmLabel: changed > 0 ? "Remove and lose the changes" : "Remove",
    discardDirty: changed > 0,
    ...(keepHeadAs && { keepHeadAs }),
  };
}
