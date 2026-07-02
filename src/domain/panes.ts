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

/** One agent pane in the grid. Each pane runs its own agent type; the display
 * title comes from `name` / the auto title / the derived "Agent N". */
export interface Pane {
  id: string;
  /** The coding agent this pane runs — per pane, NOT tied to the workspace. */
  agentType?: AgentType;
  /** Per-agent working directory (its own git worktree) when the workspace runs
   * in worktree mode; falls back to the workspace cwd when undefined. */
  cwd?: string;
  /** The agent's git branch, when it runs in a worktree. */
  branch?: string;
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
