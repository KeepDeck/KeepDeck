import type { AgentInfo, AgentType, ResumeOrigin } from "../agents";
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

/**
 * Why a pane has NO PTY behind it. One field carrying a reason rather than
 * parallel booleans: the cases are mutually exclusive answers to the same
 * question, and they differ in WHAT wakes the pane — so a consumer reading the
 * reason cannot mistake "the user parked this" for "wake me on the next
 * sweep". Only `suspended` is durable (it records the user's intent); the
 * other two describe this launch's circumstances and hydration re-derives
 * them every time.
 */
export type PaneIdle =
  /** On its way up: the revive sweep wakes it as soon as its workspace is
   * active ([F7]). `origin` says WHO asked, and that decides what a rejected
   * session id may do — a boot restore may fall back to a fresh conversation,
   * a resume the user clicked may not. `at` carries the stamp of the suspend
   * this wake came from, so a wake that fails can put the pane back exactly
   * where it was instead of restamping it. Runtime-only. */
  | { reason: "waking"; origin: ResumeOrigin; at?: string }
  /** Restored into a launch that parks agents instead of waking them: it
   * waits for the card's explicit start. Runtime-only — the launch policy is
   * a setting, not a fact about this pane, so persisting it would make
   * turning the setting off unable to bring the pane back. */
  | { reason: "parked" }
  /** The user suspended it: its process was ended deliberately and only an
   * explicit resume brings it back. Durable, and `at` dates the card. */
  | { reason: "suspended"; at: string };

/** A pane's worktree create captured as intent: everything needed to (re)issue
 * the `worktree_create` call. Kept on the pane while the create runs in the
 * background — and after a failure, so Retry can re-use it. A pane with this
 * set renders a status card instead of a terminal. */
export interface PaneProvisioning {
  /** The repository (the workspace cwd) the worktree is created in. */
  repo: string;
  /** Batch flow: the folder the worktree dir is auto-placed under. */
  baseDir?: string;
  /** This pane's create runs the workspace's one-time setup command — set by
   * the batch flow, absent for "+ Agent"/fork panes. A Retry consults THIS,
   * not a placement field's presence: a retry must never have wider effects
   * than the attempt it retries. */
  runsSetup?: true;
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
  /** This card originates from a journal FORK — its store surgery runs as a
   * post-provision step held only in memory. Runtime-only, NEVER persisted: a
   * fork whose provisioning is interrupted by a restart is dropped rather than
   * restored as a plain retryable card (which would Retry into a NON-fork
   * pane, silently losing the fork) — the user re-forks from the journal. */
  fork?: true;
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
  /** When set, the pane's agent runs against a REMOTE native-server endpoint
   * (a local thin-client attached to a server on a VPS) instead of locally.
   * Fixed at creation from the spawn dialog's "Where: Remote" choice and
   * persisted — a revive/resume reconnects the client to the same endpoint. */
  remoteEndpoint?: string;
  /** User-set display name; overrides everything ([F11] manual rename). */
  name?: string;
  /** Auto title from the terminal (OSC 0/1/2), shown when there's no manual
   * `name`; falls back to the derived "Agent N" ([F11] auto-naming). */
  autoTitle?: string;
  /** Set while there is no PTY behind this pane, saying WHY — see
   * [`PaneIdle`]. Absent means the pane runs (or is provisioning/exited, both
   * tracked outside the durable model). Cleared by the wake action; only the
   * `suspended` reason survives a save ([F7]). */
  idle?: PaneIdle;
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
 *  so the default is part of the persisted format, not a UI convenience. */
export function paneAgentType(pane: Pane): AgentType {
  return pane.agentType ?? "claude";
}

/** A remote pane runs its agent against a VPS endpoint and is fresh-session
 *  only — it has no local working directory to probe and must NEVER be handed
 *  to a resume/restart/bind path, which would spawn locally and silently drop
 *  the endpoint. The single predicate every consume site consults so the
 *  invariant lives in one place (not copy-pasted at each call site). Truthy
 *  (not `!== undefined`): an empty-string endpoint is a non-remote degenerate
 *  case, matching spawnSpecs' own truthy target-builder and the inline checks
 *  this centralized. */
export function paneIsRemoteFresh(pane: Pane): boolean {
  return !!pane.remoteEndpoint;
}

/** Whether this pane can be suspended right now — the single rule behind
 *  every affordance that offers it, so the menu, the close dialog and the
 *  card can never disagree about which panes qualify.
 *
 *  Excluded: a pane that is already idle (nothing to stop); one whose worktree
 *  create is still in flight (no process yet, and its create must not be
 *  stranded); and a REMOTE pane, whose conversation lives on the server with
 *  no local session to resume — stopping its thin client and reattaching
 *  would quietly start a different conversation. An EXITED pane qualifies:
 *  parking a dead agent is meaningful (its card becomes the honest "stopped"
 *  one, and resuming rebuilds its resume plan), and the exit is runtime state
 *  this durable model deliberately doesn't carry. */
export function paneCanSuspend(pane: Pane): boolean {
  return paneSuspendBlock(pane) === null;
}

/** WHY a pane can't be suspended, or null when it can. A reason rather than a
 *  bare `false` because three surfaces have to explain the refusal — the
 *  hotkey, the command and the close dialog — and a boolean forces each to
 *  guess, which is how one of them came to tell a remote pane's user that
 *  their running agent "has no session to stop". Mirrors the `ResumeBlock`
 *  shape the session picker already uses for the same job. */
export type PaneSuspendBlock = "idle" | "provisioning" | "remote";

export function paneSuspendBlock(pane: Pane): PaneSuspendBlock | null {
  // Only a pane that is STAYING down is refused. One still rising can be
  // stopped — that cancels the wake — and it matters: a pane in a workspace
  // the user isn't looking at stays `waking` until that workspace is
  // activated, so refusing every idle pane made those agents unparkable.
  if (paneIsStopped(pane)) return "idle";
  if (pane.provisioning) return "provisioning";
  if (paneIsRemoteFresh(pane)) return "remote";
  return null;
}

/** Whether an idle marker is one the revive sweep acts on by itself: a pane
 *  on its way up, whoever asked. A `suspended` or `parked` one is staying
 *  down until someone says otherwise. */
export function idleWakesAutomatically(idle: PaneIdle): boolean {
  return idle.reason === "waking";
}

/** Whether the revive sweep may wake this pane on its own. The single
 *  predicate the sweep consults, so the rule lives in one place. */
export function paneWakesAutomatically(pane: Pane): boolean {
  return !!pane.idle && idleWakesAutomatically(pane.idle);
}

/** Whether the pane has no process AND nothing is bringing it back on its own
 *  — the state every "this agent is not running" affordance keys on (the
 *  dimmed tile, the tray's stopped marker). A pane on its way up is excluded:
 *  it resolves in milliseconds, and marking it would only flicker. */
export function paneIsStopped(pane: Pane): boolean {
  return !!pane.idle && !idleWakesAutomatically(pane.idle);
}

/** Whether a pane READS as stopped to the user — no process, and nothing
 *  bringing it back on its own. One exported rule rather than a boolean
 *  passed down, because two surfaces ask it about the same pane (its tile
 *  dims, its minimized stand-in gets a marker) and they must not be able to
 *  disagree — nor to be handed a combination that contradicts itself.
 *
 *  `blocked` is the sweep's runtime verdict that the pane's directory is
 *  gone: such a pane is technically still rising, but it is stuck there until
 *  someone relocates it, so it reads as stopped like any other. */
export function idleReadsAsStopped(
  idle: PaneIdle | undefined,
  blocked: boolean,
): boolean {
  if (!idle) return false;
  return !idleWakesAutomatically(idle) || blocked;
}

/** The session this pane would come back to, or null when it would start a
 *  new one. One place, because three layers ask it and must agree: the card
 *  that NAMES the session to the user, the sweep that builds the resume plan,
 *  and the restart that picks resume-vs-fresh. A remote pane always answers
 *  null — its conversation lives on the server, so a local resume would be a
 *  different one. */
export function paneResumeSessionId(pane: Pane): string | null {
  return paneIsRemoteFresh(pane) ? null : (pane.session?.id ?? null);
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

/** The title a pane's journal record freezes at seal time: the manual name,
 * else the cleaned terminal auto title — never the derived "Agent N" (that is
 * positional, meaningless once the pane is gone). */
export function paneFrozenTitle(pane: Pane): string | undefined {
  return pane.name ?? cleanPaneAutoTitle(pane.autoTitle);
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
      runsSetup: true,
      workspace: ws.name,
      index: i + 1,
    },
  }));
}
