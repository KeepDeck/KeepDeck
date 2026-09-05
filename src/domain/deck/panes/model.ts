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
 * the `worktree_create` call, and nothing about how the last attempt went.
 * Kept on the pane while the create runs in the background — and after a
 * failure, so Retry re-issues exactly this. What a document stores of a
 * provisioning pane, verbatim.
 *
 * The workspace's name used to be stored here and is read live now, so a
 * document saved mid-create loses its in-flight card to an OLDER build: that
 * reader required the name and drops the intent without it. Accepted rather
 * than versioned — an unfinished create was never that build's to finish,
 * and the pane comes back plain rather than not at all. */
export interface WorktreeIntent {
  /** The repository (the workspace cwd) the worktree is created in. */
  repo: string;
  /** Where the worktree goes — resolved before the pane was ever built (the
   * "+ Agent" dialog's accepted suggestion, or a fork's target) and used
   * verbatim. Required: backend-assigned placement went with the create-time
   * agent batch, so an intent that cannot name its directory is not one. */
  path: string;
  /** Explicit branch to create; auto-named on the Rust side when absent. */
  branch?: string;
  /** The picked base branch the new branch forks from; absent = the repo HEAD
   * at create time. Part of the intent so Retry — and an interrupted create
   * restored after a restart — recreates from the same base, not a moved HEAD. */
  base?: string;
  /** The pane's position among the workspace's agents when the dialog opened
   * — the number in the auto branch name `kd/<workspace>/<index>`. A recorded
   * decision, kept so a Retry lands on the same number. The workspace's NAME
   * is the other input and is deliberately not here: it is read live when the
   * create is issued, so a rename between a failure and its Retry names the
   * branch after what the workspace is called now, not what a card remembered. */
  index: number;
}

/**
 * Where a pane runs — ONE answer.
 *
 * Four optional fields used to say this (`cwd`, `branch`, `remoteEndpoint`,
 * `provisioning`), and nothing in that shape said which combinations meant
 * something; the invariant lived in the order transforms wrote them and in a
 * guard at each reader. A union cannot hold a directory beside a create in
 * flight, or an endpoint beside a directory, so neither the transitions nor
 * the readers have to keep them apart.
 */
export type PaneLocation =
  /** No directory of its own: the pane runs in the workspace cwd. `branch`
   * is the branch the root checkout was on when this pane's session was
   * recorded — a resumed session carries it — and nothing owns it: it names
   * where the work was, not a worktree to clean up. */
  | { kind: "main"; branch?: string }
  /** A directory the pane owns or was attached to. `branch` is the worktree
   * branch when one was created or named; a pane attached to a detached
   * checkout, or resumed from a session that recorded only a directory, has
   * none — and no consumer tells those two apart. Durable: worktree
   * ownership and cleanup key off it; the header's branch badge is runtime
   * state read from the directory, not this. */
  | { kind: "attached"; cwd: string; branch?: string }
  /** The worktree is still being created, or the create failed and waits for
   * Retry. No terminal mounts until it resolves. The intent is what the
   * create is (re)issued from; beside it sits the status of this attempt,
   * which never reaches disk — hydration stamps its own. */
  | {
      kind: "provisioning";
      intent: WorktreeIntent;
      /** Why the create failed; set flips the card from creating to failed. */
      error?: string;
      /** This card originates from a journal FORK — its store surgery runs as
       * a post-provision step held only in memory. Runtime-only, NEVER
       * persisted: a fork whose provisioning is interrupted by a restart is
       * dropped rather than restored as a plain retryable card (which would
       * Retry into a NON-fork pane, silently losing the fork) — the user
       * re-forks from the journal. */
      fork?: true;
    }
  /** The agent runs against a REMOTE native-server endpoint — the local
   * terminal is a thin client attached to a server on a VPS. A local
   * directory would be meaningless, so none is carried. Fixed at creation
   * from the spawn dialog's "Where: Remote" choice and persisted: a revive
   * reconnects the client to the same endpoint. */
  | { kind: "remote"; endpoint: string };

/** The provisioning placement on its own — the card a pane wears while its
 * worktree is created, in the shape the surfaces that draw it take. */
export type PaneProvisioning = Extract<PaneLocation, { kind: "provisioning" }>;

/** One agent pane in the grid. Each pane runs its own agent type; the display
 * title comes from `name` / the auto title / the derived "Agent N". */
export interface Pane {
  id: string;
  /** The coding agent this pane runs — per pane, NOT tied to the workspace. */
  agentType?: AgentType;
  /** Where the pane runs — see [`PaneLocation`]. Absent means `main`: the
   * pane runs in the workspace cwd, sparse like every other field here. On
   * disk this is the four fields the union replaced, folded on the way in and
   * unfolded on the way out, so no document changed shape. */
  location?: PaneLocation;
  /** The agent runs with its permission prompts disabled (YOLO mode). Fixed
   * at creation from the dialog/form choice and persisted: a revive or resume
   * must come back in the mode the user created the pane with. */
  yolo?: boolean;
  /** User-set display name; overrides everything ([F11] manual rename). */
  name?: string;
  /** Auto title from the terminal (OSC 0/1/2), shown when there's no manual
   * `name`; falls back to the derived "Agent N" ([F11] auto-naming). */
  autoTitle?: string;
  /** Set while there is no PTY behind this pane, saying WHY — see
   * [`PaneIdle`]. Absent means the pane runs (or is exited, which is tracked
   * outside the durable model; a create in flight is a `location`). Cleared
   * by the wake action; only the `suspended` reason survives a save ([F7]). */
  idle?: PaneIdle;
  /** The recorded agent session this pane resumes on revive ([F7]/[F8]). */
  session?: PaneSession;
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
