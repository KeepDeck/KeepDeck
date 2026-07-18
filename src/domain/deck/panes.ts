import type { AgentInfo, AgentType } from "../agents";
import { MAX_PANES, clampPaneCount } from "./layout";
// Type-only, so the module graph stays acyclic at runtime (reducer's chain
// imports this module; the types are erased).
import type { WorkspaceView } from "./reducer";

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
  /** The picked base branch the new branch forks from; absent = the repo HEAD
   * at create time. Part of the intent so Retry — and an interrupted create
   * restored after a restart — recreates from the same base, not a moved HEAD. */
  base?: string;
  /** Workspace name and agent index — the auto branch-name inputs. */
  workspace: string;
  index: number;
  /** Why the create failed; set flips the card from creating to failed. */
  error?: string;
  /** The worktree exists and the workspace's one-time setup command is
   * running in it. Runtime-only, like `error`: never persisted — a restart
   * mid-setup comes back as the interrupted failed card. */
  phase?: "setup";
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
  /** The owned git worktree branch created/attached for this pane. This is
   * durable domain state used for worktree ownership and cleanup fallback; the
   * header's current branch badge is runtime UI state derived from the pane's
   * effective cwd, not stored here. */
  branch?: string;
  /** The agent runs with its permission prompts disabled (YOLO mode). Fixed
   * at creation from the dialog/form choice and persisted: a revive or resume
   * must come back in the mode the user created the pane with. */
  yolo?: boolean;
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
  /** Persisted keys this build doesn't know (written by a newer revision) —
   * carried verbatim so a save round-trip never strips them. */
  extras?: Record<string, unknown>;
}

/** The id for the pane numbered `seq` — the single mint point, since it's the
 * agent↔`WorktreeRecord` join key and every site must agree. */
export function paneId(seq: number): string {
  return `pane-${seq}`;
}

/** The agent a pane runs — panes minted before the field existed ran claude,
 * so the default is part of the persisted format, not a UI convenience. */
export function paneAgentType(pane: Pane): AgentType {
  return pane.agentType ?? "claude";
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
 * Split panes into the ones still on the grid (`live`) and the ones minimized
 * out of it (`minimized`) — the tray/strip minimize styles. A minimized id
 * that no longer matches a pane is simply ignored, so the minimized set
 * self-heals over any pane removal without every removal path having to prune
 * it. Order within each group follows the pane order; when nothing is
 * minimized the SAME `panes` array is returned as `live` (a stable ref for
 * render memoization).
 */
export function partitionPanes(
  panes: Pane[],
  minimized: readonly string[] | undefined,
): { live: Pane[]; minimized: Pane[] } {
  if (!minimized || minimized.length === 0) return { live: panes, minimized: [] };
  const set = new Set(minimized);
  const live: Pane[] = [];
  const out: Pane[] = [];
  for (const pane of panes) (set.has(pane.id) ? out : live).push(pane);
  return { live, minimized: out };
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

/** The slice of `WorkspaceView` pane visibility depends on. A `Pick` (not a
 * restated structural shape): every field here is optional, so a hand-rolled
 * copy would accept ANY object and a reducer-side rename would silently feed
 * `undefined` into visibility decisions — the type-only import keeps renames
 * a compile error without pulling in reducer logic. */
type PaneVisibilityView = Pick<
  WorkspaceView,
  "focus" | "select" | "minimized"
>;

/**
 * Whether the pane's BODY is actually being rendered right now, given its
 * workspace's panes, view state and the deck's display mode — the same
 * semantics DeckStage paints (list default-expands the first pane; grid
 * resolves a stale maximize via [`resolveFocus`]; a minimized pane only
 * leaves the grid while the minimize styles are in force). Callers own the
 * "is the workspace active / is a modal covering the deck" half — this
 * answers only the layout's part. Drives banner suppression: a wrong `true`
 * swallows a needed OS banner, a wrong `false` merely shows a redundant one.
 */
export function paneOnScreen(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
  layout: "grid" | "list",
  minimizeOn: boolean,
  paneId: string,
): boolean {
  if (layout === "list") {
    return (view?.select ?? panes[0]?.id) === paneId;
  }
  const { live } = partitionPanes(
    panes,
    minimizeOn ? view?.minimized : undefined,
  );
  if (!live.some((pane) => pane.id === paneId)) return false;
  const focused = resolveFocus(live, view?.focus);
  return focused === null || focused === paneId;
}

/** Display title for the pane at `index`: the manual name wins, then the
 * terminal's auto title, then "<Agent label> N" from the catalog — falling back
 * to the raw agent id while the catalog is still loading ([F11]). */
export function paneDisplayTitle(
  pane: Pane,
  index: number,
  agents: AgentInfo[],
): string {
  const agentType = paneAgentType(pane);
  const label = agents.find((a) => a.id === agentType)?.label ?? agentType;
  return pane.name ?? cleanPaneAutoTitle(pane.autoTitle) ?? `${label} ${index + 1}`;
}

/** Claude Code prefixes some OSC titles with a decorative/status glyph. Keep the
 * raw autoTitle for persistence, but do not make one agent family look like it
 * has a bespoke pane-header icon. */
function cleanPaneAutoTitle(title: string | undefined): string | undefined {
  const cleaned = title?.replace(/^[✦✧✶✳✱✲✷✸✹✺✻✼✽]\s+/, "").trim();
  return cleaned || undefined;
}

/** Build `count` panes numbered from `startSeq` (clamped to MAX_PANES), all
 * running `agentType`; `yolo` marks every pane (sparse — false never lands). */
export function makePanes(
  startSeq: number,
  count: number,
  agentType: AgentType,
  yolo = false,
): Pane[] {
  const n = clampPaneCount(count);
  return Array.from({ length: n }, (_, i) => ({
    id: paneId(startSeq + i),
    agentType,
    ...(yolo && { yolo: true }),
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
  yolo = false,
): Pane[] {
  const n = clampPaneCount(count);
  return Array.from({ length: n }, (_, i) => ({
    id: paneId(startSeq + i),
    agentType,
    ...(yolo && { yolo: true }),
    provisioning: {
      repo: ws.cwd,
      baseDir: ws.baseDir,
      workspace: ws.name,
      index: i + 1,
    },
  }));
}
