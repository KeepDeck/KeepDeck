import { paneBlock, type Pane } from "./panes";

/**
 * What a pane's BODY shows — one answer to "is this thing running", for every
 * surface that asks.
 *
 * The sibling of [`paneRunIntent`]: that one decides whether a process should
 * exist, this one decides what the user sees while it does or doesn't. They
 * are deliberately separate — a pane can legitimately have no process and
 * still show a terminal's scrollback, and a hold reason the run sweep keeps
 * waiting on is not always a card — but they must agree on PRECEDENCE, and
 * they did not: the render rebuilt the whole conjunction by hand at two more
 * sites, each spelling out `!spec && !idle && !provisioning && !unavailable`.
 *
 * Being a hand-written ladder is what made it silently incomplete. A new hold
 * reason — a quota gate, an unreachable endpoint — had no rung, so every pane
 * in that state fell through to "waiting" and sat on "Waking up…" forever
 * with nothing failing to compile. Adding a member here is a compile error at
 * every consumer instead.
 */
export type PaneBody =
  /** Its worktree is still being created; there is nothing to run in yet. */
  | "provisioning"
  /** No installed plugin provides its agent — that explains the pane whatever
   * else is also true of it. */
  | "agent-unavailable"
  /** It carries an idle marker: the card reads the marker for the reason. */
  | "stopped"
  /** Its plan build failed — an error tile with a retry, rather than a
   * placeholder that never resolves. */
  | "plan-failed"
  /** No plan yet. The honest reading of "we don't know what to run". */
  | "waiting"
  /** A plan exists: mount the terminal. */
  | "terminal";

/** What the answer cannot read off the pane itself. */
export interface PaneBodyEnv {
  /** A plugin currently provides this pane's agent — and the catalog has
   * settled enough to say so, since "not loaded yet" is not "missing". */
  agentAvailable: boolean;
  /** Its spawn plan is built and published. */
  hasPlan: boolean;
  /** Its last plan build FAILED. */
  planFailed: boolean;
}

export function paneBody(pane: Pane, env: PaneBodyEnv): PaneBody {
  // The shared head, asked once rather than restated: provisioning makes
  // everything else moot, an absent agent explains the pane whatever else is
  // true, and a marker means someone put it down.
  const block = paneBlock(pane, env.agentAvailable);
  if (block) return block.kind === "stopped" ? "stopped" : block.kind;
  // A plan outranks a past failure: a rebuild that succeeded is the newer
  // answer, and leaving the error tile up would offer a retry for something
  // that already worked.
  if (env.hasPlan) return "terminal";
  return env.planFailed ? "plan-failed" : "waiting";
}
