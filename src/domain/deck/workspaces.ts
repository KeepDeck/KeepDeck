import {
  classifyLocation,
  type DirectoryState,
  type PathProbe,
} from "../agents";
import type {
  WorkspaceInstance,
  WorkspaceRef,
} from "../workspaceInstance";
import { appendPane, removePane, type Pane } from "./panes";
import { teamsOf } from "./teams/collection";
import { claimPath, normalizePath, teamOccupyingPath } from "./teams/lifecycle";
import type { Team } from "./teams/model";

/** What the create-workspace form submits: the spec a new workspace is
 * provisioned from. A workspace is born EMPTY, so nothing per-agent belongs
 * here — the agent type and its YOLO mode are decided by whoever adds an
 * agent, one agent at a time. */
export interface SpawnConfig {
  /** Workspace name; blank falls back to a default in the caller. */
  name: string;
  cwd: string;
  /** Base folder for per-agent git worktrees; `null` = agents run in `cwd`. */
  worktreeBaseDir: string | null;
}

/** A workspace owns its own set of agent panes, rooted at one working
 * directory. Each pane carries its OWN agent type — they were homogeneous only
 * while a workspace was created with a batch. Switching the active workspace
 * swaps which set the grid shows; inactive workspaces keep their panes (and
 * live sessions) mounted. */
export interface Workspace {
  id: string;
  /** Non-reused runtime identity. `id` is a reusable `ws-N` slot. */
  readonly instance: WorkspaceInstance;
  name: string;
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

/** Resolve one exact workspace lifetime, never merely its reusable id. */
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
 * and the one an empty rename resets to. ONE derivation for both moments:
 * creation and reset used to derive it separately (sequence template vs an
 * id regex), agreeing only because the two templates happened to share a
 * number. An id outside the `ws-N` scheme (a hand-edited or migrated deck)
 * falls back to the id itself — the least-wrong name that still identifies
 * the row. */
export function autoWorkspaceName(id: string): string {
  const slot = /^ws-(\d+)$/.exec(id);
  return slot ? `workspace-${slot[1]}` : id;
}

/** Rename one workspace, leaving the rest untouched. An empty name reverts
 * to [`autoWorkspaceName`] — the same reset-on-empty contract `renamePane`
 * has, so the two inline-rename surfaces behave alike ([F11]). A workspace
 * has no render-time fallback the way a pane does, so the revert happens
 * here. */
export function renameWorkspace(
  workspaces: Workspace[],
  id: string,
  name: string,
): Workspace[] {
  return workspaces.map((ws) =>
    ws.id === id ? { ...ws, name: name.trim() || autoWorkspaceName(ws.id) } : ws,
  );
}

/** Set a pane's manual display name; an empty name clears it, reverting to the
 * auto title / derived label ([F11]). */
/**
 * What the deck says about `path` for a location field — see
 * [`DirectoryState`]. The ONE deck reader behind every such field: the agent
 * dialog's worktree path and the fork target's alike, so the two cannot
 * answer the same directory differently.
 */
export function directoryState(
  workspaces: readonly Workspace[],
  /** The workspace the field belongs to — its root is its own, and a team
   * abroad on it is not a claim here. */
  ws: Workspace,
  path: string,
): DirectoryState {
  const claim = claimPath(workspaces, ws, path);
  if (claim.kind === "free") return "free";
  return claim.creating ? "being-created" : "worked-in";
}

/** One worktree branch/folder name suggestion (mirrors the Rust
 * `WorktreeSuggestion`); `suggest` in [`firstFreeTeamWorktree`] yields these per
 * index, `null` when no suggestion could be produced. */
export interface WorktreeNameSuggestion {
  branch: string;
  folder: string;
}

/** How many suggestion indices [`firstFreeTeamWorktree`] tries before giving up.
 * Occupied paths are bounded by the open pane count, so any real deck resolves
 * in a handful of steps — the cap only backstops a pathological `suggest`. */
const MAX_SUGGESTION_TRIES = 100;

/**
 * The first suggested worktree path under `baseDir` NOT held by an open pane,
 * with its matching branch — folder and branch advance together so the pair
 * stays consistent (`kd-ws-3` ↔ `kd/ws/3`). A path that merely exists on disk
 * stays suggestible (attaching to an idle worktree is a valid outcome) —
 * EXCEPT when `probe` classifies it as blocked (a non-empty non-worktree dir,
 * e.g. a leftover folder): suggesting one would open the dialog straight onto
 * an error. `probe` must never reject; a `null` probe result (backend down)
 * keeps the candidate — the dialog's live hint still guards the actual create.
 * `null` when `suggest` yields nothing or every try is taken.
 */
export async function firstFreeTeamWorktree(
  workspaces: Workspace[],
  baseDir: string,
  suggest: (index: number) => Promise<WorktreeNameSuggestion | null>,
  startIndex: number,
  probe?: (path: string) => Promise<PathProbe | null>,
): Promise<{ path: string; branch: string } | null> {
  const base = normalizePath(baseDir);
  for (let i = startIndex; i < startIndex + MAX_SUGGESTION_TRIES; i++) {
    const s = await suggest(i);
    if (!s) return null;
    const path = `${base}/${s.folder}`;
    if (teamOccupyingPath(workspaces, path)) continue;
    const p = probe ? await probe(path) : null;
    if (p && classifyLocation(path, p) === "blocked") continue;
    return { path, branch: s.branch };
  }
  return null;
}

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

// The pane→directory projections live in [`./roots`]: everything KeepDeck
// plants in a working directory keys off them, and they change for entirely
// different reasons than workspace membership or pane state do.

/** Move the workspace with `id` to `toIndex` (clamped to the list), preserving
 * the order of the rest. Returns the SAME array reference when nothing moves, so
 * a live drag that lands on the current slot doesn't trigger a re-render. */
export function moveWorkspace(
  workspaces: Workspace[],
  id: string,
  toIndex: number,
): Workspace[] {
  const from = workspaces.findIndex((ws) => ws.id === id);
  if (from < 0) return workspaces;
  const to = Math.max(0, Math.min(toIndex, workspaces.length - 1));
  if (from === to) return workspaces;
  const next = workspaces.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Which workspace to focus: keep `activeId` if it still exists, otherwise the
 * first remaining workspace (or `""` when none remain). */
export function resolveActiveId(workspaces: Workspace[], activeId: string): string {
  if (workspaces.some((ws) => ws.id === activeId)) return activeId;
  return workspaces[0]?.id ?? "";
}
