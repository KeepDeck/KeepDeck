import {
  classifyLocation,
  type AgentType,
  type Occupancy,
  type PathProbe,
} from "../agents";
import type {
  WorkspaceInstance,
  WorkspaceRef,
} from "../workspaceInstance";
import { appendPane, removePane, type Pane } from "./panes";

/** A workspace owns its own set of agent panes, all running the same agent type
 * in the same working directory. Switching the active workspace swaps which set
 * the grid shows; inactive workspaces keep their panes (and live sessions)
 * mounted. */
/** What the create-workspace form submits: the spec a new workspace (and its
 * initial batch of agents) is provisioned from. */
export interface SpawnConfig {
  /** Workspace name; blank falls back to a default in the caller. */
  name: string;
  cwd: string;
  agentType: AgentType;
  count: number;
  /** Base folder for per-agent git worktrees; `null` = agents run in `cwd`. */
  worktreeBaseDir: string | null;
  /** One-time worktree setup command (experimental run presets); blank/absent
   * = none. */
  setup?: string;
  /** Every spawned agent runs in YOLO mode; absent = off. Only ever true for
   * an agent whose plugin declares support (the form gates the toggle). */
  yolo?: boolean;
}

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
  /** One-time worktree-preparation command (deps, .env copies), run once by
   * core provisioning after `worktree_create`. A core field, not part of the
   * Run plugin's config — the workspace needs it prepared regardless of
   * whether that plugin is installed. Failure surfaces on the provisioning
   * card like any other create-time failure. */
  setup?: string;
  /** Per-plugin persisted state, one opaque slot per plugin id. The slot's
   * CONTENT is the owning plugin's business — never inspected here, like an
   * unknown `agentType` below the persistence boundary — only the bag SHAPE
   * (an id-keyed record) is ours. Lives here — not in its own document — so
   * deleting the workspace deletes every plugin's state for it structurally,
   * like `run`. */
  plugins?: Record<string, unknown>;
  /** Persisted keys this build doesn't know (written by a newer revision) —
   * carried verbatim so a save round-trip never strips them. */
  extras?: Record<string, unknown>;
  panes: Pane[];
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
 * The worktrees owned by a workspace's panes — just the one pane when `paneId`
 * is given (agent close), else every pane (workspace close). A cwd-fallback pane
 * (the main repo) has no worktree of its own, and a non-worktree workspace owns
 * nothing — an empty result is the signal that there's nothing to offer deleting.
 *
 * The directory is ALWAYS offered; only the NAMED branch varies with what's
 * known about the worktree's HEAD:
 * - runtime HEAD observed on a branch → that currently checked-out branch;
 * - runtime HEAD observed but DETACHED → none named (naming one would be
 *   ambiguous on a bare commit — the dir is not: skipping it, as this once
 *   did, stranded the directory on disk with the delete checkbox gone);
 * - HEAD not observed → the pane's durable owned branch, when it has one.
 *
 * Naming is only the explicit half: the delete flow additionally reaps
 * branches born in the worktree (`reapCreatedBranches`) — see
 * [`WorktreeTarget.branch`].
 */
export function worktreeTargets(
  ws: Workspace,
  paneId?: string,
  gitPositions?: ReadonlyMap<string, GitPosition>,
): WorktreeTarget[] {
  const panes = paneId ? ws.panes.filter((p) => p.id === paneId) : ws.panes;
  return panes.flatMap((p) => {
    if (!p.cwd) return [];
    const observed = gitPositions?.get(p.cwd);
    return [
      { repo: ws.cwd, path: p.cwd, branch: observed ? observed.branch : p.branch },
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
/** A pane already running in a directory, and where it lives — the reason a
 * candidate worktree path can't take a second agent. */
export interface PathOccupant {
  ws: Workspace;
  pane: Pane;
  /** The pane's index in its workspace (feeds the display-title derivation). */
  index: number;
}

/** Path spelling differences that don't change the directory: surrounding
 * whitespace and trailing slashes. NOT a canonicalizer (no fs access) — two
 * genuinely different spellings of one dir (symlinks, `..`) stay distinct. */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? trimmed : stripped;
}

/**
 * The pane already occupying `path`, or `null` when it's free. Scans EVERY
 * workspace's panes: a pane's worktree can live anywhere — `worktreeBaseDir`
 * is only a suggestion source, so workspace-level paths predict nothing.
 * Dormant panes count (they revive right back into their directory), and so
 * does a provisioning pane from the "+ Agent" flow: it has no `cwd` yet but
 * holds its explicit target `path`. A BATCH provisioning pane is the exception
 * — its exact worktree dir is assigned by the backend (with collision suffixes)
 * and isn't known here, so it only starts occupying a path once its create
 * resolves and it gains a `cwd`.
 * This is what blocks the "+ Agent" dialog from attaching a second agent to a
 * worktree one pane already runs in (two agents in one dir stomp each other's
 * files and git state).
 */
export function paneOccupyingPath(
  workspaces: Workspace[],
  path: string,
): PathOccupant | null {
  const wanted = normalizePath(path);
  if (!wanted) return null;
  for (const ws of workspaces) {
    for (const [index, pane] of ws.panes.entries()) {
      const held = pane.cwd ?? pane.provisioning?.path;
      if (held && normalizePath(held) === wanted) return { ws, pane, index };
    }
  }
  return null;
}

/** How a pane holds `path` — see [`Occupancy`]: a pane with a `cwd` RUNS in
 * the dir (so it provably is a live worktree), a provisioning intent merely
 * targets it. This distinction is what lets the agent dialog offer "attach
 * anyway" instantly, without waiting for a filesystem probe. */
export function pathOccupancy(
  workspaces: Workspace[],
  path: string,
): Occupancy {
  const hit = paneOccupyingPath(workspaces, path);
  if (!hit) return null;
  return hit.pane.cwd ? "worktree" : "provisioning";
}

/** One worktree branch/folder name suggestion (mirrors the Rust
 * `WorktreeSuggestion`); `suggest` in [`firstFreeWorktree`] yields these per
 * index, `null` when no suggestion could be produced. */
export interface WorktreeNameSuggestion {
  branch: string;
  folder: string;
}

/** How many suggestion indices [`firstFreeWorktree`] tries before giving up.
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
export async function firstFreeWorktree(
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
    if (paneOccupyingPath(workspaces, path)) continue;
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
