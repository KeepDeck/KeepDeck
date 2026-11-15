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
  sameDirectory,
  teamOccupyingPath,
  type RepoCheckout,
  type UnheldRemoval,
  type Workspace,
} from "../domain/deck";
import { byCount, counted } from "./countWords";

export const WORKTREE_WORDS = {
  title: "Worktrees",
  hint: "Every checkout of this repository, from git worktree list. One no team holds can be removed here; its branch always stays.",
  newTeam: "New team in a worktree",
  loading: "Reading the repository's checkouts…",
  notARepo: "Not a git repository — it has no worktrees.",
  remove: "Remove…",
  clean: "no changes",
  unknownChanges: "changes unknown",
  gone: "folder gone",
  locked: "locked",
  free: "no team",
  root: "the workspace's own folder",
} as const;

export interface WorktreeRowView {
  path: string;
  /** The branch, or the detached commit it stands on. */
  branch: string;
  /** What is in it: changes, or that its folder is gone. */
  state: string;
  /** Who holds it. */
  holder: string;
  /** Offered only for a checkout nobody holds, whose folder is there. */
  removable: boolean;
}

export interface WorktreeTableView {
  rows: WorktreeRowView[];
}

/** Who holds `path`, in words — or null when nobody does. */
function holderOf(path: string, workspace: Workspace, workspaces: readonly Workspace[]): string | null {
  const roots = workspaces.filter((ws) => sameDirectory(ws.cwd, path));
  if (roots.length > 0) {
    return roots.some((ws) => ws.id === workspace.id)
      ? WORKTREE_WORDS.root
      : `the folder of ${roots.map((ws) => `“${ws.name}”`).join(", ")}`;
  }
  const holding = teamOccupyingPath(workspaces, path);
  if (!holding) return null;
  return holding.ws.id === workspace.id
    ? `team “${holding.team.name}”`
    : `team “${holding.team.name}” in “${holding.ws.name}”${holding.ws.archived ? " (archived)" : ""}`;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "?");

export function worktreeTableView(
  listed: readonly RepoCheckout[],
  workspace: Workspace,
  workspaces: readonly Workspace[],
): WorktreeTableView {
  return {
    rows: listed.map((row) => {
      const holder = holderOf(row.path, workspace, workspaces);
      const state = row.prunable
        ? WORKTREE_WORDS.gone
        : row.changed === null
          ? WORKTREE_WORDS.unknownChanges
          : row.changed === 0
            ? WORKTREE_WORDS.clean
            : `${counted(row.changed, "changed entry", "changed entries")}`;
      return {
        path: row.path,
        branch: row.branch ?? `detached at ${short(row.head)}`,
        state: row.locked ? `${state} · ${WORKTREE_WORDS.locked}` : state,
        holder: holder ?? WORKTREE_WORDS.free,
        removable: holder === null && !row.prunable && !row.locked,
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
