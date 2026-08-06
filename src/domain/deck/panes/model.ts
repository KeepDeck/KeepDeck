/**
 * The pane model: what a pane IS, and the id it is minted with.
 *
 * The questions asked ABOUT a pane live next door — [`./lifecycle`] answers
 * what it may do right now, [`./collection`] works on a workspace's list of
 * them, and [`./factories`] builds them; [`./index`] re-exports all four so
 * consumers keep importing panes as one thing.
 *
 * Separate from that barrel on purpose. The model used to live IN it, which
 * made every sibling that needed `Pane` — or worse, `paneId`, a value — import
 * from the barrel that re-exports those very siblings. A real ESM cycle,
 * survived only because `paneId` is a hoisted function declaration: turn it
 * into a const arrow and the import order decides whether the app boots.
 */
import type { AgentType, ResumeOrigin } from "../../agents";

/** The agent session a pane is bound to — the resume key ([F7]/[F8]). Bound at
 * save time while the pane is alive (spawn-diff over the agent's own store),
 * consumed at revive time to build the native resume args. */
export interface PaneSession {
  /** The agent's own session id (claude uuid / codex uuid / opencode id). */
  id: string;
  /** ISO instant this session was first bound to the pane (diagnostics). A
   * re-report of the SAME id keeps the original; only a different id restamps. */
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
  /** On its way up: the revive sweep wakes it as soon as it can ([F7]).
   * `origin` says WHO asked, and that decides what a rejected session id may
   * do — a boot restore may fall back to a fresh conversation, a resume the
   * user clicked may not. `from` is the state this wake started in, carried
   * whole so a wake that FAILS can put the pane back exactly where it was;
   * absent when the pane rose from a restore. Runtime-only. */
  | { reason: "waking"; origin: ResumeOrigin; from?: PaneStopped }
  | PaneStopped;

/**
 * The half of [`PaneIdle`] that STAYS down: no process, and nothing bringing
 * the pane back but an explicit gesture. Named because a wake carries the
 * state it rose from ([`PaneIdle`]'s `from`) and must be able to restore it
 * verbatim — decoding it from a flag is how a reason the user never chose
 * gets written back as one they did.
 */
export type PaneStopped =
  /** Down without a decision behind it. Two producers, one behaviour: a pane
   * restored into a launch that parks agents instead of waking them, and a
   * pane whose stored marker could not be read (a hand edit, a truncated
   * write, a reason from a newer build) — for which "stay down behind a card"
   * is the non-destructive reading. Runtime-only in both cases: the launch
   * policy is a setting rather than a fact about this pane, and an unreadable
   * marker is not a decision to make durable. */
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
  /** Which team this agent belongs to, and under what role. Durable: a team
   * describes a piece of work in progress, and a deck restored tomorrow
   * should come back with the same one. Absent = not in a team, which is
   * every pane until somebody says otherwise. */
  team?: PaneTeam;
  /** Persisted keys this build doesn't know (written by a newer revision) —
   * carried verbatim so a save round-trip never strips them. */
  extras?: Record<string, unknown>;
}

/**
 * A pane's place in a team.
 *
 * `role` is an ADDRESS, not a job title: it is how teammates name each other
 * ("ask impl-1"), which is why it has to be unique inside its team and why
 * `lead` is simply the role the lead happens to hold rather than a separate
 * flag. One team per pane, because two would make "who is the lead here"
 * a question with more than one answer.
 */
export interface PaneTeam {
  name: string;
  role: string;
}

/** The id for the pane numbered `seq` — the single mint point, since it's the
 * agent↔`WorktreeRecord` join key and every site must agree. */
export function paneId(seq: number): string {
  return `pane-${seq}`;
}
