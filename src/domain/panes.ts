import type { AgentInfo, AgentType } from "./agents";
import { MAX_PANES, clampPaneCount } from "./layout";

/** The agent session a pane is bound to — the resume key ([F7]/[F8]). Bound at
 * save time while the pane is alive (spawn-diff over the agent's own store),
 * consumed at revive time to build the native resume args. */
export interface PaneSession {
  /** The agent's own session id (claude uuid / codex uuid / opencode id). */
  id: string;
  /** ISO instant the binding was made (diagnostics; newer binding wins). */
  boundAt: string;
}

/** A pane's worktree create captured as intent: everything needed to (re)issue
 * the `worktree_create` call. Kept on the pane while the create runs in the
 * background — and after a failure, so Retry can re-use it. A pane with this
 * set renders a status card instead of a terminal. */
export interface PaneProvisioning {
  /** The repository (the workspace cwd) the worktree is created in. */
  repo: string;
  /** Batch flow: the folder the worktree dir is auto-placed under. */
  baseDir?: string;
  /** Exact user-chosen worktree path (the "+ Agent" dialog flow). */
  path?: string;
  /** Explicit branch to create; the batch flow auto-names on the Rust side. */
  branch?: string;
  /** Workspace name and agent index — the auto branch-name inputs. */
  workspace: string;
  index: number;
  /** Why the create failed; set flips the card from creating to failed. */
  error?: string;
}

/** One agent pane in the grid. Each pane runs its own agent type; the display
 * title comes from `name` / the auto title / the derived "Agent N". */
export interface Pane {
  id: string;
  /** The coding agent this pane runs — per pane, NOT tied to the workspace. */
  agentType?: AgentType;
  /** Per-agent working directory (its own git worktree) when the workspace runs
   * in worktree mode; falls back to the workspace cwd when undefined. */
  cwd?: string;
  /** The agent's git branch, when it runs in a worktree. Kept LIVE: the HEAD
   * watcher updates it on every checkout inside the worktree, and clears it
   * when the worktree goes detached. */
  branch?: string;
  /** The checked-out commit when the worktree is detached (no branch).
   * Runtime-only, like `dormant`: never persisted — the watcher re-emits the
   * current state at registration on every boot. */
  head?: string;
  /** User-set display name; overrides everything ([F11] manual rename). */
  name?: string;
  /** Auto title from the terminal (OSC 0/1/2), shown when there's no manual
   * `name`; falls back to the derived "Agent N" ([F11] auto-naming). */
  autoTitle?: string;
  /** Restored from disk but not yet revived — no PTY behind it. Runtime-only:
   * set by hydration, cleared by the revive action, never persisted ([F7]). */
  dormant?: boolean;
  /** The recorded agent session this pane resumes on revive ([F7]/[F8]). */
  session?: PaneSession;
  /** The in-flight (or failed) worktree create behind this pane — no terminal
   * mounts until it resolves. */
  provisioning?: PaneProvisioning;
}

/** The id for the pane numbered `seq` — the single mint point, since it's the
 * agent↔`WorktreeRecord` join key and every site must agree. */
export function paneId(seq: number): string {
  return `pane-${seq}`;
}

/**
 * Append an already-formed `pane` (e.g. one whose worktree is provisioned),
 * unless the fleet is already at [`MAX_PANES`]. Pure: returns the same array
 * (unchanged) when at the cap.
 */
export function appendPane(panes: Pane[], pane: Pane): Pane[] {
  if (panes.length >= MAX_PANES) return panes;
  return [...panes, pane];
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
}

/**
 * The pane that should render maximized, or `null` when none does. A workspace
 * with a single pane is never maximized ([U1]: maximize is a no-op on a solo
 * pane — the lone tile already fills the grid), and a `focusedId` that no longer
 * matches any pane (e.g. the maximized pane was just closed) resolves to none.
 */
export function resolveFocus(
  panes: Pane[],
  focusedId: string | undefined,
): string | null {
  if (!focusedId || panes.length <= 1) return null;
  return panes.some((pane) => pane.id === focusedId) ? focusedId : null;
}

/** Display title for the pane at `index`: the manual name wins, then the
 * terminal's auto title, then "<Agent label> N" from the catalog — falling back
 * to the raw agent id while the catalog is still loading ([F11]). */
export function paneDisplayTitle(
  pane: Pane,
  index: number,
  agents: AgentInfo[],
): string {
  const agentType = pane.agentType ?? "claude";
  const label = agents.find((a) => a.id === agentType)?.label ?? agentType;
  return pane.name ?? pane.autoTitle ?? `${label} ${index + 1}`;
}

/** What the pane-header badge shows for a pane's git position: the branch, or
 * a shortened commit id when the worktree is detached (`full` feeds the
 * tooltip). `null` for a pane outside any worktree — no badge. */
export function paneBranchBadge(
  pane: Pane,
): { label: string; full: string } | null {
  if (pane.branch) return { label: pane.branch, full: pane.branch };
  if (pane.head) return { label: pane.head.slice(0, 7), full: pane.head };
  return null;
}

/** Build `count` panes numbered from `startSeq` (clamped to MAX_PANES), all
 * running `agentType`. */
export function makePanes(
  startSeq: number,
  count: number,
  agentType: AgentType,
): Pane[] {
  const n = clampPaneCount(count);
  return Array.from({ length: n }, (_, i) => ({
    id: paneId(startSeq + i),
    agentType,
  }));
}

/** Build `count` panes numbered from `startSeq` that are still WAITING for
 * their worktrees: each carries its create intent (per-index, for the auto
 * branch name) so the background runner — and a later Retry — can issue the
 * actual create. The deck shows them immediately; terminals mount as each
 * create resolves. */
export function makeProvisioningPanes(
  startSeq: number,
  count: number,
  agentType: AgentType,
  ws: { cwd: string; baseDir: string; name: string },
): Pane[] {
  const n = clampPaneCount(count);
  return Array.from({ length: n }, (_, i) => ({
    id: paneId(startSeq + i),
    agentType,
    provisioning: {
      repo: ws.cwd,
      baseDir: ws.baseDir,
      workspace: ws.name,
      index: i + 1,
    },
  }));
}
