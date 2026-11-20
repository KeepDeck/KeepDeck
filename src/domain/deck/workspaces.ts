import {
  classifyLocation,
  type DirectoryState,
  type PathProbe,
} from "../agents";
import type {
  WorkspaceInstance,
  WorkspaceRef,
} from "../workspaceInstance";
import { appendPane, paneStopsWithArchive, removePane, type Pane } from "./panes";
import { suspendedAt } from "./panes/stamp";
import { teamsOf } from "./teams/collection";
import { claimPath, normalizePath, sameDirectory, teamOccupyingPath } from "./teams/claims";
import type { Team } from "./teams/model";

/** What the create-workspace form submits: the spec a new workspace is
 * provisioned from. A workspace is born EMPTY, so nothing per-agent belongs
 * here — the agent type and its YOLO mode are decided by whoever adds an
 * agent, one agent at a time. */
export interface SpawnConfig {
  /** Workspace name as typed; [`workspaceName`] decides what blank means. */
  name: string;
  cwd: string;
  /** Base folder for per-agent git worktrees as typed; [`worktreeBaseDirOf`]
   * decides what blank means (`null` = agents run in `cwd`). */
  worktreeBaseDir: string | null;
}

/** A workspace owns its own set of agent panes, rooted at one working
 * directory. Each pane carries its OWN agent type — they were homogeneous only
 * while a workspace was created with a batch. Switching the active workspace
 * swaps which set the grid shows; inactive workspaces keep their panes (and
 * live sessions) mounted. */
export interface Workspace {
  /** `ws-` and a random token, minted once and never handed to another
   * workspace (`mintWorkspaceId`). Older decks hold `ws-N`; those stay
   * valid. */
  id: string;
  /** This run's identity of the workspace — minted at create and at
   * hydrate, never persisted — what a stale reference held across a close
   * is checked against. */
  readonly instance: WorkspaceInstance;
  name: string;
  /** The letters its mark says, when the person chose them: 1-2 characters
   * of any script ([`parseWorkspaceMark`]). Absent = the letters are worked
   * out from the name, unique across the deck. */
  mark?: string;
  /** Working directory all this workspace's agents run in. */
  cwd: string;
  /** Base folder holding this workspace's per-agent git worktrees; `null` when
   * agents run directly in `cwd` (no isolation). */
  worktreeBaseDir: string | null;
  /** Per-plugin persisted state, one opaque slot per plugin id. The slot's
   * CONTENT is the owning plugin's business — never inspected here, like an
   * unknown `agentType` below the persistence boundary — only the bag SHAPE
   * (an id-keyed record) is ours. Lives here — not in its own document — so
   * deleting the workspace deletes every plugin's state for it structurally,
   * like `run`. */
  plugins?: Record<string, unknown>;
  /** Persisted keys this build does not own — written by a newer revision, or
   * RETIRED by this one (deck v5's `setup` command, whose only runner was the
   * create-time agent batch) — carried verbatim so a save round-trip never
   * strips them. A retired key lands here by simply leaving `WS_KNOWN_KEYS`:
   * the value stops meaning anything and stays on disk untouched. */
  extras?: Record<string, unknown>;
  panes: Pane[];
  /** The teams running here — the objects; who is ON one is read off the
   * panes, which hold the id. Sparse: a workspace with no teams carries no
   * key, like `plugins`. Read through `teamsOf`. */
  teams?: Team[];
  /** Put away ([`WorkspaceArchived`]); absent on a workspace in use. */
  archived?: WorkspaceArchived;
}

/** What an archive could not finish, kept on its marker so boot repair
 * retries exactly that and nothing else: the panes whose process did not
 * stop, and whether taking KeepDeck's plantings back out of the workspace's
 * directories failed. Never present empty. */
export interface ArchiveWarnings {
  reaps: string[];
  disarm: boolean;
}

/**
 * A workspace put away: kept whole — its teams, panes, view, board and
 * artifacts, its id never handed to another — but not drawn, not selectable
 * and not run. ONE flag on the row, and four readings of it: the whole list
 * (identity, ownership, retention) keeps every row; navigation reads
 * [`visibleWorkspaces`]; the run gate and the arming of directories read the
 * flag. Nothing filters the deck's list as such.
 *
 * `phase` is the commit point a crash resumes from: `"archiving"` while its
 * agents are being stopped (boot repair finishes the job), `"archived"` once
 * the stop pass has done what it could.
 */
export interface WorkspaceArchived {
  /** When it was put away. */
  at: string;
  phase: "archiving" | "archived";
  warnings?: ArchiveWarnings;
}

/** Apply a pane transform to the workspace with `id`, leaving the rest as-is.
 * Exported for the pane transforms, which are all shaped this way. */
export function mapWorkspace(
  workspaces: Workspace[],
  id: string,
  transform: (panes: Pane[]) => Pane[],
): Workspace[] {
  return workspaces.map((ws) =>
    ws.id === id ? { ...ws, panes: transform(ws.panes) } : ws,
  );
}

/** The workspace `id`, if present — the deck's by-id selector, so app hooks
 * don't each re-implement `workspaces.find((w) => w.id === …)`. */
export function findWorkspace(
  workspaces: Workspace[],
  id: string,
): Workspace | undefined {
  return workspaces.find((w) => w.id === id);
}

/** Resolve one exact workspace lifetime — id AND this run's instance. */
export function findWorkspaceByRef(
  workspaces: Workspace[],
  ref: WorkspaceRef,
): Workspace | undefined {
  const workspace = findWorkspace(workspaces, ref.id);
  return workspace?.instance === ref.instance ? workspace : undefined;
}

/** One public id names at most one live workspace. */
export function workspaceIdsAreUnique(
  workspaces: readonly Workspace[],
): boolean {
  return new Set(workspaces.map((workspace) => workspace.id)).size ===
    workspaces.length;
}

/** The workspace that owns pane `paneId`, if any. */
export function findWorkspaceOfPane(
  workspaces: readonly Workspace[],
  paneId: string,
): Workspace | undefined {
  return workspaces.find((w) => w.panes.some((p) => p.id === paneId));
}

/** The pane `paneId` of workspace `workspaceId`, if both exist. */
export function findPane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Pane | undefined {
  return findWorkspace(workspaces, workspaceId)?.panes.find((p) => p.id === paneId);
}

/** Append an already-formed agent pane (e.g. with a provisioned worktree) to one
 * workspace, respecting its cap. */
export function addAgentPane(
  workspaces: Workspace[],
  workspaceId: string,
  pane: Pane,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) => appendPane(panes, pane));
}

/** Remove an agent pane from one workspace. */
export function closeAgent(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    removePane(panes, paneId),
  );
}

/** Remove a workspace. Its panes unmount, which tears down their PTY sessions. */
export function closeWorkspace(workspaces: Workspace[], id: string): Workspace[] {
  return workspaces.filter((ws) => ws.id !== id);
}

/** One checkout of a repository, as `git worktree list` reports it — with
 * how much uncommitted work it holds. */
export interface RepoCheckout {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  /** Its folder is gone; only git's record of it is left. */
  prunable: boolean;
  /** Entries `git status` calls changed, ignored files aside; null when that
   * could not be asked. */
  changed: number | null;
}

/** A checkout no team holds, to remove. */
export interface UnheldRemovalRequest {
  repo: string;
  path: string;
  /** Keep its commit as `refs/tags/<keepHeadAs>` before it goes — for a
   * detached checkout, whose commits no branch holds. */
  keepHeadAs?: string;
  /** The person agreed to lose its uncommitted work. */
  discardDirty: boolean;
}

/** What removing an unheld checkout did. */
export type UnheldRemoval =
  | { kind: "removed"; keptAs?: string }
  /** A team holds it now; nothing was touched. */
  | { kind: "held" }
  /** Its commit could not be kept; nothing was removed. */
  | { kind: "not-kept"; reason: string }
  /** Git refused, or finished only part of it. */
  | { kind: "failed"; reason: string; keptAs?: string };

/** A git worktree (and its branch, when one is known) to tear down when an
 * agent or workspace closes. */
export interface WorktreeTarget {
  /** The repository (the workspace cwd) the git ops run against. */
  repo: string;
  /** The worktree directory to remove. */
  path: string;
  /** The branch to delete BY NAME once the worktree is gone, when the pane
   * still tracks one. Absent for a detached-HEAD worktree — the dir is still
   * removed, and no branch is named here. Naming is not the whole story:
   * the delete flow also reaps branches BORN in the worktree (the user's
   * checkbox says "and its branches"), so absence means "nothing to name",
   * never "no branch will be touched". */
  branch?: string;
}

/** Why a worktree teardown left its target in place — a kind, never a
 * sentence (the words are presentation's `teardownFailureText`): another
 * live workspace still works in the folder, or git refused. */
export type WorktreeTeardownFailure =
  | { kind: "held-elsewhere"; target: WorktreeTarget }
  | { kind: "git-refused"; target: WorktreeTarget; reason: string };

/** Runtime git position for a path, supplied by the app layer when available.
 * This is intentionally not pane domain state: panes own durable worktree
 * intent/branch, while current HEAD is observed at runtime. */
export interface GitPosition {
  branch?: string;
  head?: string;
}

/**
 * The worktrees a workspace's TEAMS hold — just the one team when `teamId`
 * is given (a disband), else every team (a workspace close). A directory is
 * a team's, never a pane's, so a member closing is never asked about one.
 *
 * A team on the workspace root holds no worktree of its own: the root is
 * never a deletion target, structurally — a team there disbands without
 * the offer. A team whose create is still out has no directory yet to
 * name (the close flow covers it by its ticket), and a non-worktree
 * workspace's teams all run in the root — an empty result is the signal
 * that there's nothing to offer deleting.
 *
 * The directory is ALWAYS offered; only the NAMED branch varies with what's
 * known about the worktree's HEAD:
 * - runtime HEAD observed on a branch → that currently checked-out branch;
 * - runtime HEAD observed but DETACHED → none named (naming one would be
 *   ambiguous on a bare commit — the dir is not: skipping it, as this once
 *   did, stranded the directory on disk with the delete checkbox gone);
 * - HEAD not observed → the team's durable owned branch, when it has one.
 *
 * Naming is only the explicit half: the delete flow additionally reaps
 * branches born in the worktree (`reapCreatedBranches`) — see
 * [`WorktreeTarget.branch`].
 */
export function worktreeTargets(
  ws: Workspace,
  teamId?: string,
  gitPositions?: ReadonlyMap<string, GitPosition>,
): WorktreeTarget[] {
  const root = normalizePath(ws.cwd);
  return teamsOf(ws)
    .filter((team) => teamId === undefined || team.id === teamId)
    .flatMap((team) => {
      const location = team.location;
      if (location?.kind !== "attached" || normalizePath(location.cwd) === root) {
        return [];
      }
      const observed = gitPositions?.get(location.cwd);
      return [
        {
          repo: ws.cwd,
          path: location.cwd,
          branch: observed ? observed.branch : location.branch,
        },
      ];
    });
}

/** Set (or, via `undefined`, delete) one plugin's opaque persisted slot in a
 * workspace's plugin bag. The slot's CONTENT is never inspected here — only
 * the bag shape is ours (the slot content is opaque, only the
 * bag shape is ours). Deleting the last slot drops the whole bag so the persisted
 * document stays sparse, like an emptied `run`. Returns the SAME array when
 * nothing actually changes — deleting an already-absent slot, or setting a
 * slot to the value it already holds — so a resubmit from the host-rendered
 * settings UI causes no re-render. */
export function setWorkspacePluginSlot(
  workspaces: Workspace[],
  wsId: string,
  pluginId: string,
  value: unknown | undefined,
): Workspace[] {
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws) return workspaces;
  if (ws.plugins?.[pluginId] === value) return workspaces;
  return workspaces.map((w) => {
    if (w.id !== wsId) return w;
    if (value === undefined) {
      const { [pluginId]: _gone, ...rest } = w.plugins ?? {};
      if (Object.keys(rest).length === 0) {
        const { plugins: _empty, ...others } = w;
        return others;
      }
      return { ...w, plugins: rest };
    }
    return { ...w, plugins: { ...w.plugins, [pluginId]: value } };
  });
}

/** The name a workspace is born with when the user leaves the field blank —
 * and the one an empty rename resets to: ONE derivation for both moments,
 * from the folder it works in — what the create form suggests too — never
 * from the id, which is a random token. A folder with no name of its own
 * (the root) gives "Workspace". */
export function autoWorkspaceName(cwd: string): string {
  return baseName(cwd) || "Workspace";
}

/** The name a workspace takes from what someone typed: the text trimmed,
 * or [`autoWorkspaceName`] of its folder when nothing is left. ONE rule for
 * the moment a workspace is born and every later edit, so a blank field
 * means the same thing in the create form, the Workspaces window and a
 * command. */
export function workspaceName(raw: string, cwd: string): string {
  return raw.trim() || autoWorkspaceName(cwd);
}

/** The worktree base folder a workspace takes from what someone typed:
 * trimmed — the deck compares paths trimmed (`normalizePath`), and a pasted
 * " /wt " means /wt — and a blank field is no base folder at all. ONE rule
 * for creation and every later edit. */
export function worktreeBaseDirOf(raw: string | null): string | null {
  const path = raw?.trim() ?? "";
  return path === "" ? null : path;
}

/** The longest letters a mark holds — what fits its tile. */
export const WORKSPACE_MARK_MAX = 2;

/**
 * A workspace's own letters from what someone typed — ONE rule for the page,
 * the command and the document: trimmed; 1-2 CHARACTERS, counted by code
 * point so any script fits ("KD", "Ра", "项目") and an emoji is one; blank is
 * no mark of its own (the letters go back to the name's). Longer is refused.
 */
export function parseWorkspaceMark(raw: string): { mark: string | undefined } | { refused: "mark-too-long" } {
  const mark = raw.trim();
  if (mark === "") return { mark: undefined };
  return Array.from(mark).length > WORKSPACE_MARK_MAX ? { refused: "mark-too-long" } : { mark };
}

/** Whether `path` names a folder from the root rather than from wherever
 * the app happens to run: `/…`, `C:\…`, or a `\\server\share` path. A
 * workspace's directory is where its agents start, its repository and its
 * worktrees' repo — a relative one names a different folder per process. */
export function isAbsolutePath(path: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** What an edit may change on a workspace. Absent = leave as is. The values
 * are what someone typed: [`workspaceName`] and [`worktreeBaseDirOf`] decide
 * what blank means, exactly as at birth. */
export interface WorkspacePatch {
  name?: string;
  /** Its own letters; blank = back to the name's ([`parseWorkspaceMark`]). */
  mark?: string;
  cwd?: string;
  /** `null` or blank = no base folder. */
  worktreeBaseDir?: string | null;
}

/** Why an edit was refused — kinds, never words: each surface says them its
 * own way (a field hint, a command error). */
export type WorkspaceUpdateRefusal =
  | { kind: "unknown-workspace" }
  /** Put away: nothing of it changes until it is restored. */
  | { kind: "archived" }
  | { kind: "cwd-not-empty"; teams: number; panes: number }
  | { kind: "blank-cwd" }
  | { kind: "relative-cwd" }
  | { kind: "mark-too-long" };

export type WorkspaceUpdateResult =
  | { ok: true; workspaces: Workspace[] }
  | { ok: false; refusal: WorkspaceUpdateRefusal };

/**
 * Whether a workspace's working directory is fixed now — THE rule, asked by
 * the edit that would change it and by every surface that offers to.
 *
 * Only an EMPTY workspace may move: a team, and a pane on no team, run in
 * the root or were planted against its repository (their worktrees are torn
 * down with git run in `cwd`), so moving it under them would leave their
 * processes behind and point their cleanup at another repository. Null
 * when the directory may change; otherwise what holds it.
 */
export function cwdLocked(ws: Workspace): { teams: number; panes: number } | null {
  const teams = teamsOf(ws).length;
  const panes = ws.panes.length;
  return teams > 0 || panes > 0 ? { teams, panes } : null;
}

/**
 * Edit one workspace lifetime — the ONE transition for its own fields: its
 * name, its worktree base folder and, while nothing runs there, its working
 * directory.
 *
 * Addressed by the exact lifetime, so an edit begun against a workspace that
 * was closed meanwhile lands nowhere. An archived workspace is read-only.
 * Refuses rather than half-applies. A patch that changes nothing returns the
 * same array, so a surface that writes on every blur causes no transition.
 */
export function updateWorkspace(
  workspaces: Workspace[],
  ref: WorkspaceRef,
  patch: WorkspacePatch,
): WorkspaceUpdateResult {
  const ws = findWorkspaceByRef(workspaces, ref);
  if (!ws) return { ok: false, refusal: { kind: "unknown-workspace" } };
  if (ws.archived) return { ok: false, refusal: { kind: "archived" } };
  const next: Workspace = { ...ws };
  // Trimmed, the way the deck compares every path; the same folder is no move.
  const cwd = patch.cwd?.trim();
  if (cwd !== undefined && !sameDirectory(cwd, ws.cwd)) {
    if (cwd === "") return { ok: false, refusal: { kind: "blank-cwd" } };
    if (!isAbsolutePath(cwd)) return { ok: false, refusal: { kind: "relative-cwd" } };
    const held = cwdLocked(ws);
    if (held) return { ok: false, refusal: { kind: "cwd-not-empty", ...held } };
    next.cwd = cwd;
  }
  // After the move: a blank name is the folder's, and it is the NEW folder.
  if (patch.name !== undefined) next.name = workspaceName(patch.name, next.cwd);
  if (patch.worktreeBaseDir !== undefined) {
    next.worktreeBaseDir = worktreeBaseDirOf(patch.worktreeBaseDir);
  }
  if (patch.mark !== undefined) {
    const parsed = parseWorkspaceMark(patch.mark);
    if ("refused" in parsed) return { ok: false, refusal: { kind: parsed.refused } };
    if (parsed.mark === undefined) delete next.mark;
    else next.mark = parsed.mark;
  }
  const changed =
    next.name !== ws.name ||
    next.cwd !== ws.cwd ||
    next.worktreeBaseDir !== ws.worktreeBaseDir ||
    next.mark !== ws.mark;
  return {
    ok: true,
    workspaces: changed ? workspaces.map((w) => (w === ws ? next : w)) : workspaces,
  };
}

/** Set a pane's manual display name; an empty name clears it, reverting to the
 * auto title / derived label ([F11]). */

/** The directory containing `path`, or `""` when there is no usable parent
 * (a bare name, or a direct child of the filesystem root) — string-only, no
 * fs access. Fallback base for suggesting a worktree NEXT TO an occupied path
 * when the workspace has no base folder of its own. */
export function parentDir(path: string): string {
  const norm = normalizePath(path);
  const cut = norm.lastIndexOf("/");
  return cut <= 0 ? "" : norm.slice(0, cut);
}

/** The last component of `path` — the folder name a worktree path implies,
 * `""` when there is none (empty input, filesystem root). String-only, no
 * fs access. */
export function baseName(path: string): string {
  const norm = normalizePath(path);
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/** `path` spelled under the home folder as `~` — `~/Projects/x` — the
 * home folder itself as `~`; any other path as it is. String-only. */
export function homeRelative(path: string, home: string | null): string {
  if (!home) return path;
  const norm = normalizePath(path);
  const base = normalizePath(home);
  if (norm === base) return "~";
  return norm.startsWith(`${base}/`) ? `~${norm.slice(base.length)}` : path;
}

// The pane→directory projections live in [`./roots`]: everything KeepDeck
// plants in a working directory keys off them, and they change for entirely
// different reasons than workspace membership or pane state do.

/** Where a workspace goes in the column: right before or right after another
 * one, named by id. A place, not an index — an index means a position in ONE
 * list, and the column a person sees and the deck's full list stop being the
 * same list the moment any workspace is not drawn; an id means the same row
 * in both. */
export type WorkspacePlace = { before: string } | { after: string };

/** Move the workspace with `id` to `place`, preserving the order of the rest.
 * Returns the SAME array reference when nothing moves — an unknown id or
 * anchor, a workspace placed beside itself, or one already where it is asked
 * to go — so a live drag that lands on the current slot doesn't re-render. */
export function moveWorkspace<T extends { id: string }>(
  workspaces: T[],
  id: string,
  place: WorkspacePlace,
): T[] {
  const anchor = "before" in place ? place.before : place.after;
  const moved = workspaces.find((ws) => ws.id === id);
  if (!moved || anchor === id) return workspaces;
  const rest = workspaces.filter((ws) => ws.id !== id);
  const at = rest.findIndex((ws) => ws.id === anchor);
  if (at < 0) return workspaces;
  const next = [...rest];
  next.splice("before" in place ? at : at + 1, 0, moved);
  return next.every((ws, i) => ws === workspaces[i]) ? workspaces : next;
}

/** The places "Move up" and "Move down" take the workspace `id` to in a
 * column drawn in `order`: before its upper neighbour, after its lower one —
 * null at that end of the column, or for an id the column does not hold. */
export function stepPlaces(
  order: readonly string[],
  id: string,
): { up: WorkspacePlace | null; down: WorkspacePlace | null } {
  const at = order.indexOf(id);
  if (at < 0) return { up: null, down: null };
  return {
    up: at > 0 ? { before: order[at - 1] } : null,
    down: at < order.length - 1 ? { after: order[at + 1] } : null,
  };
}

/** What asking to put a workspace away did: it is archived now, it already
 * was, a close of it is under way, or it is no longer there. */
export type ArchiveOutcome = "archived" | "already" | "closing" | "gone";

/** What asking for a workspace back did. */
export type RestoreOutcome = "restored" | "not-archived" | "gone";

/** The workspaces a person navigates — every one not archived, in deck
 * order: the strip's, the selection's. Identity, ownership and retention
 * keep reading the whole list. */
export function visibleWorkspaces<T extends Pick<Workspace, "archived">>(
  workspaces: readonly T[],
): T[] {
  return workspaces.filter((ws) => ws.archived === undefined);
}

/** Which workspace to focus: keep `activeId` while it names one a person can
 * see, otherwise the first visible workspace — or `""` when there is none:
 * no workspace at all, or every one archived. */
export function resolveActiveId(workspaces: Workspace[], activeId: string): string {
  const visible = visibleWorkspaces(workspaces);
  if (visible.some((ws) => ws.id === activeId)) return activeId;
  return visible[0]?.id ?? "";
}

/** Every pane the archive stops ([`paneStopsWithArchive`]), marked suspended as of
 * `at`; the same list when none is left to mark. */
function suspendedForArchive(ws: Workspace, at: string): Pane[] {
  let marked = false;
  const panes = ws.panes.map((pane): Pane => {
    if (!paneStopsWithArchive(ws, pane)) return pane;
    marked = true;
    return suspendedAt(pane, at);
  });
  return marked ? panes : ws.panes;
}

/** Put workspace `id` away as of `at`, in phase `"archiving"` — and, in the
 * same change, every pane the archive stops marked suspended: one snapshot,
 * one save, so no crash can leave the workspace put away with a pane on disk
 * that would rise by itself. Ending the processes is the caller's. Same ref
 * when there is no such workspace or it is already archived. */
export function archiveWorkspace(workspaces: Workspace[], id: string, at: string): Workspace[] {
  const ws = findWorkspace(workspaces, id);
  if (!ws || ws.archived) return workspaces;
  return workspaces.map((w) =>
    w.id === id ? { ...w, archived: { at, phase: "archiving" }, panes: suspendedForArchive(w, at) } : w,
  );
}

/** The archive of `id` has done what it could: phase `"archived"`, owing
 * `warnings` (kept only when something is owed) — and any pane that landed
 * since the archive began (a create that finished) marked suspended like the
 * rest. Boot repair settles again after each retry, with what is still owed.
 * Same ref when the workspace is not archived, or already settled exactly so. */
export function settleArchive(
  workspaces: Workspace[],
  id: string,
  warnings: ArchiveWarnings,
): Workspace[] {
  const ws = findWorkspace(workspaces, id);
  const archived = ws?.archived;
  if (!ws || !archived) return workspaces;
  const panes = suspendedForArchive(ws, archived.at);
  const owed = warnings.reaps.length > 0 || warnings.disarm;
  const was = archived.warnings;
  const unchanged =
    panes === ws.panes &&
    archived.phase === "archived" &&
    (owed
      ? was !== undefined &&
        was.disarm === warnings.disarm &&
        was.reaps.length === warnings.reaps.length &&
        was.reaps.every((paneId, i) => paneId === warnings.reaps[i])
      : was === undefined);
  if (unchanged) return workspaces;
  const settled: WorkspaceArchived = {
    at: archived.at,
    phase: "archived",
    ...(owed && { warnings: { reaps: [...warnings.reaps], disarm: warnings.disarm } }),
  };
  return workspaces.map((w) => (w.id === id ? { ...w, archived: settled, panes } : w));
}

/** Bring workspace `id` back: the marker goes and nothing else changes —
 * every pane stays as the archive left it, and waking them is the person's,
 * one by one. Same ref when it is not archived. */
export function restoreWorkspace(workspaces: Workspace[], id: string): Workspace[] {
  if (!findWorkspace(workspaces, id)?.archived) return workspaces;
  return workspaces.map((w) => {
    if (w.id !== id) return w;
    const { archived: _restored, ...rest } = w;
    return rest;
  });
}
