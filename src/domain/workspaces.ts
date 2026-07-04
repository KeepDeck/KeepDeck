import type { AgentType } from "./agents";
import type { Occupancy } from "./agentLocation";
import type { WorkspaceRun } from "./runPresets";
import { appendPane, removePane, type Pane, type PaneSession } from "./panes";

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
}

export interface Workspace {
  id: string;
  name: string;
  /** Working directory all this workspace's agents run in. */
  cwd: string;
  /** Base folder holding this workspace's per-agent git worktrees; `null` when
   * agents run directly in `cwd` (no isolation). */
  worktreeBaseDir: string | null;
  /** Launch presets + the one-time worktree setup command (experimental).
   * Lives here — not in its own document — so deleting the workspace deletes
   * its run config structurally, like the panes. */
  run?: WorkspaceRun;
  panes: Pane[];
}

/** Apply a pane transform to the workspace with `id`, leaving the rest as-is. */
function mapWorkspace(
  workspaces: Workspace[],
  id: string,
  transform: (panes: Pane[]) => Pane[],
): Workspace[] {
  return workspaces.map((ws) =>
    ws.id === id ? { ...ws, panes: transform(ws.panes) } : ws,
  );
}

/** The pane `paneId` of workspace `workspaceId`, if both exist. */
function findPane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Pane | undefined {
  return workspaces
    .find((w) => w.id === workspaceId)
    ?.panes.find((p) => p.id === paneId);
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

/** A git worktree + branch to tear down when an agent or workspace closes. */
export interface WorktreeTarget {
  /** The repository (the workspace cwd) the git ops run against. */
  repo: string;
  /** The worktree directory to remove. */
  path: string;
  /** The branch to delete once the worktree is gone. */
  branch: string;
}

/**
 * The worktrees owned by a workspace's panes — just the one pane when `paneId`
 * is given (agent close), else every pane (workspace close). Only panes that
 * actually run in a worktree (both a `cwd` and a `branch`) are returned; a
 * cwd-fallback pane, or a non-worktree workspace, owns nothing to delete, so an
 * empty result is the signal that there's nothing to offer deleting.
 */
export function worktreeTargets(ws: Workspace, paneId?: string): WorktreeTarget[] {
  const panes = paneId ? ws.panes.filter((p) => p.id === paneId) : ws.panes;
  return panes.flatMap((p) =>
    p.cwd && p.branch ? [{ repo: ws.cwd, path: p.cwd, branch: p.branch }] : [],
  );
}

/** Replace one workspace's run configuration (preset saved/removed, setup
 * edited); an empty config (no presets, no setup) drops the field so the
 * persisted document stays sparse. */
export function setWorkspaceRun(
  workspaces: Workspace[],
  id: string,
  run: WorkspaceRun,
): Workspace[] {
  const empty = run.presets.length === 0 && run.setup === undefined;
  return workspaces.map((ws) => {
    if (ws.id !== id) return ws;
    if (empty) {
      const { run: _gone, ...rest } = ws;
      return rest;
    }
    return { ...ws, run };
  });
}

/** Rename one workspace, leaving the rest untouched. */
export function renameWorkspace(
  workspaces: Workspace[],
  id: string,
  name: string,
): Workspace[] {
  return workspaces.map((ws) => (ws.id === id ? { ...ws, name } : ws));
}

/** Set a pane's manual display name; an empty name clears it, reverting to the
 * auto title / derived label ([F11]). */
export function renamePane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  name: string,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId ? { ...p, name: name.trim() || undefined } : p,
    ),
  );
}

/** Set a pane's auto title from the terminal (OSC title); empty clears it ([F11]). */
export function setPaneAutoTitle(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  title: string,
): Workspace[] {
  const next = title.trim() || undefined;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => (p.id === paneId ? { ...p, autoTitle: next } : p)),
  );
}

/** Wake a dormant (restored, no PTY) pane so its terminal mounts and spawns
 * ([F7]). Returns the SAME array when the pane is absent or already live, so
 * a repeated revive effect doesn't re-render anything. */
export function revivePane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane?.dormant) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { dormant: _dormant, ...live } = p;
      return live;
    }),
  );
}

/** Record the agent session a live pane is bound to — the resume key persisted
 * with the deck ([F7]/[F8]) — or DROP it (`null`) when the recorded session
 * turned out dead (a fresh revive must not keep pointing at a ghost, or the
 * pane's real session is never re-bound). Same-id rebinds and clearing an
 * already-clear pane return the SAME array (no-op). */
export function setPaneSession(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  session: PaneSession | null,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || (pane.session?.id ?? null) === (session?.id ?? null))
    return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      if (session) return { ...p, session };
      const { session: _dead, ...rest } = p;
      return rest;
    }),
  );
}

/** Detach a pane from its (gone) worktree so it can start fresh in the
 * workspace cwd ([F7] restore reconcile): drops `cwd`/`branch`/`head` AND the
 * recorded session — a directory-bound session can't resume somewhere else.
 * Returns the SAME array when there's nothing to drop. */
export function resetPaneLocation(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || (!pane.cwd && !pane.branch && !pane.head && !pane.session))
    return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { cwd: _cwd, branch: _branch, head: _head, session: _session, ...rest } = p;
      return rest;
    }),
  );
}

/** A worktree's current git position, as delivered by the HEAD watcher:
 * on a branch, or detached at a commit. */
export interface PaneHead {
  branch?: string;
  head?: string;
}

/** Record where a pane's worktree currently is — the live-branch-badge update.
 * Sets `branch` on a checkout, swaps it for `head` on a detach. Same-position
 * events (checkout touches HEAD more than once) return the SAME array. */
export function setPaneHead(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  next: PaneHead,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || (pane.branch === next.branch && pane.head === next.head))
    return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { branch: _branch, head: _head, ...rest } = p;
      return {
        ...rest,
        ...(next.branch !== undefined && { branch: next.branch }),
        ...(next.head !== undefined && { head: next.head }),
      };
    }),
  );
}

/** The pane's background worktree create landed: pin the pane to the created
 * worktree and drop the provisioning card so its terminal mounts. Returns the
 * SAME array when the pane is gone (closed mid-create — the stray worktree on
 * disk is accepted; worktrees survive closes anyway) or wasn't provisioning. */
export function resolvePaneProvisioning(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  worktree: { cwd: string; branch: string },
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane?.provisioning) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { provisioning: _done, ...rest } = p;
      return { ...rest, cwd: worktree.cwd, branch: worktree.branch };
    }),
  );
}

/** Record why a pane's worktree create failed — the card flips to the failed
 * state showing it — or clear it (`null`) when a Retry starts, flipping back
 * to creating. Returns the SAME array for a gone / non-provisioning pane and
 * when the error already equals the target. */
export function setPaneProvisioningError(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  error: string | null,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane?.provisioning) return workspaces;
  if (
    (pane.provisioning.error ?? null) === error &&
    pane.provisioning.phase === undefined
  )
    return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId || !p.provisioning) return p;
      // The phase resets with the error either way: a failure ends the setup
      // it reported, and a Retry restarts at the create step.
      const { error: _old, phase: _phase, ...intent } = p.provisioning;
      return {
        ...p,
        provisioning: error === null ? intent : { ...intent, error },
      };
    }),
  );
}

/** Mark which step a pane's provisioning is at — the card's status line
 * ("Creating worktree…" vs "Running setup…"). Only ever set on a live,
 * un-failed provisioning; the SAME array otherwise. */
export function setPaneProvisioningPhase(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  phase: "setup",
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane?.provisioning || pane.provisioning.error !== undefined) return workspaces;
  if (pane.provisioning.phase === phase) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId && p.provisioning
        ? { ...p, provisioning: { ...p.provisioning, phase } }
        : p,
    ),
  );
}

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
 * does a provisioning intent: a pane whose worktree create is still in flight
 * (or failed, awaiting Retry) has no `cwd` yet but holds its target path.
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
 * stays consistent (`kd-ws-3` ↔ `kd/ws/3`). Only in-app occupancy is skipped:
 * a path that merely exists on disk stays suggestible (attaching to an idle
 * worktree is a valid outcome). `null` when `suggest` yields nothing or every
 * try is occupied.
 */
export async function firstFreeWorktree(
  workspaces: Workspace[],
  baseDir: string,
  suggest: (index: number) => Promise<WorktreeNameSuggestion | null>,
  startIndex: number,
): Promise<{ path: string; branch: string } | null> {
  const base = normalizePath(baseDir);
  for (let i = startIndex; i < startIndex + MAX_SUGGESTION_TRIES; i++) {
    const s = await suggest(i);
    if (!s) return null;
    const path = `${base}/${s.folder}`;
    if (!paneOccupyingPath(workspaces, path)) return { path, branch: s.branch };
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

/** The distinct worktree directories the deck's panes run in — the set the
 * HEAD-watch lifecycle keeps registered (a pane without `cwd` runs in the
 * workspace folder and owns no worktree to watch). */
export function worktreeCwds(workspaces: Workspace[]): Set<string> {
  const cwds = new Set<string>();
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      if (pane.cwd) cwds.add(pane.cwd);
    }
  }
  return cwds;
}

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
