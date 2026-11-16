/**
 * The Workspaces page's Worktrees table — every checkout of the workspace's
 * repository, from `git worktree list`, and who holds each: decided apart
 * from the markup.
 *
 * Who holds a folder is the deck's one answer (`claimsOf`, through
 * `teamOccupyingPath`), read over EVERY workspace, archived ones included:
 * an archive keeps its directories. Only a checkout nobody holds offers
 * Remove — a held one names its holder, and is closed with its team.
 */
import {
  baseName,
  normalizePath,
  sameDirectory,
  teamOccupyingPath,
  type RepoCheckout,
  type UnheldRemoval,
  type Workspace,
} from "../domain/deck";
import { byCount, counted } from "./countWords";

export const WORKTREE_WORDS = {
  title: "Worktrees",
  hint: "A checkout no team holds can be removed here; its branch always stays.",
  newTeam: "New team in a worktree",
  loading: "Reading the repository's checkouts…",
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
  holderKind: "root" | "team" | "free";
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

/** Who holds `path`: a workspace's own folder, a team (here, or in another
 * workspace — an archived one said so), or nobody. */
function holderOf(path: string, workspace: Workspace, workspaces: readonly Workspace[]): Holder {
  const roots = workspaces.filter((ws) => sameDirectory(ws.cwd, path));
  if (roots.length > 0) {
    const elsewhere = roots.filter((ws) => ws.id !== workspace.id).map((ws) => ws.name);
    return {
      holder: roots.some((ws) => ws.id === workspace.id) ? WORKTREE_WORDS.root : `${WORKTREE_WORDS.root} · ${elsewhere.join(", ")}`,
      holderKind: "root",
      team: null,
    };
  }
  const holding = teamOccupyingPath(workspaces, path);
  if (!holding) return { holder: WORKTREE_WORDS.free, holderKind: "free", team: null };
  const here = holding.ws.id === workspace.id;
  return {
    holder: here
      ? holding.team.name
      : `${holding.team.name} · ${holding.ws.name}${holding.ws.archived ? " (archived)" : ""}`,
    holderKind: "team",
    team: holding.ws.archived ? null : { wsId: holding.ws.id, teamId: holding.team.id },
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

export function worktreeTableView(
  listed: readonly RepoCheckout[],
  workspace: Workspace,
  workspaces: readonly Workspace[],
): WorktreeTableView {
  return {
    rows: listed.map((row) => {
      const holder = holderOf(row.path, workspace, workspaces);
      return {
        path: row.path,
        folder: worktreeFolder(row.path, workspace.cwd),
        branch: row.branch ?? short(row.head),
        detached: row.branch === null,
        ...holder,
        ...stateOf(row),
        removable: holder.holderKind === "free" && !row.prunable && !row.locked,
      };
    }),
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

/** What a removal did, said after it. */
export function unheldRemovalWords(outcome: UnheldRemoval): string {
  const kept = "keptAs" in outcome && outcome.keptAs ? ` Its commit is kept as ${outcome.keptAs.replace(/^refs\/tags\//, "")}.` : "";
  switch (outcome.kind) {
    case "removed":
      return `Removed.${kept}`;
    case "held":
      return "A team works there now, so it was left as it is.";
    case "not-kept":
      return `Its commit could not be kept (${outcome.reason}), so nothing was removed.`;
    case "failed":
      return `Git refused: ${outcome.reason}${kept}`;
  }
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
    title: `Remove the checkout at “${baseName(row.path)}”?`,
    message: lines.join("\n\n"),
    confirmLabel: changed > 0 ? "Remove and lose the changes" : "Remove",
    discardDirty: changed > 0,
    ...(keepHeadAs && { keepHeadAs }),
  };
}
