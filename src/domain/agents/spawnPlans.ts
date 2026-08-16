/**
 * Who asked for a continuation, and what an exited pane's card may ask for.
 *
 * Product vocabulary, not mechanism: the origin of a resume decides whether a
 * session that turns out to be gone may silently become a DIFFERENT
 * conversation — only boot restoration may, because nobody is watching, while
 * a resume the user asked for by name has to stay visibly refused. That rule
 * outlives any CLI's flags and would still hold if the deck were driven from
 * a terminal, which is what puts it here.
 *
 * The plan those words end up on is an Application shape and lives with the
 * builder, in `app/spawnSpecs/plans.ts`.
 */

/** Why a resume plan was requested. Only boot restoration may fall back to
 * one automatic fresh spawn when the recorded session no longer exists;
 * user-requested resumes must leave the exited pane visible. */
export type ResumeOrigin = "restore" | "manual";

/** What the live-session registry said about a session the CLI just refused
 * to resume. `null` is its own answer: the agent's plugin has no registry
 * capability, and the question was never asked. */
export type LiveRegistryAnswer = "live" | "absent" | "unknown";

/** What to do with a boot restoration whose resume the CLI refused — the
 * ONE decision this module owns for that exit. */
export type RejectedResumeAction =
  /** Held by an outside process: the binding stays, the pane offers the
   * person a choice (open in the CLI's manager, fork a copy, leave it). */
  | { kind: "keep"; registry: "live" | "unknown" }
  /** Not in the registry — but the registry speaks about LIVENESS, not
   * existence: an agent that finished between the refusal and the query
   * disappears from it while the conversation stays fully resumable. One
   * quiet retry; only its second silent death is evidence the recorded
   * id is truly dead. */
  | { kind: "retry-once" }
  /** The old behavior, whole: drop the binding, one automatic fresh
   * spawn — the recorded session really is gone. */
  | { kind: "legacy-fresh" };

/**
 * Decide a refused boot restore from what the registry said.
 *
 * The rule this replaces read a silent CLI refusal as "the session is
 * gone" — sound when refusals had three causes (deleted, GC'd, never
 * materialized), wrong the day a fourth appeared: the session exists and
 * is BUSY. The registry, not the refusal text, is the source of truth.
 *
 * UNKNOWN is treated like LIVE, deliberately: erasing a binding on
 * unknown risks the exact harm this rule exists to end (a live
 * conversation lost), while keeping a dead one costs a visible pane with
 * a choice. The asymmetry is the point.
 *
 * Only the restore path ever asks — a resume the user asked for by name
 * stays visibly refused by its own older rule, whatever the registry
 * says. `alreadyRetried` is how the one quiet retry stays one: it is the
 * same marker the retry's own plan carries.
 */
export function decideRejectedResume(
  answer: LiveRegistryAnswer | null,
  alreadyRetried: boolean,
): RejectedResumeAction {
  if (answer === "live") return { kind: "keep", registry: "live" };
  if (answer === "unknown") return { kind: "keep", registry: "unknown" };
  // No capability to ask (or an answer never arrived) is NOT "absent":
  // "absent" is a claim the registry made, and only a claim may authorize
  // the retry that precedes the legacy wipe.
  if (answer === null || alreadyRetried) return { kind: "legacy-fresh" };
  return { kind: "retry-once" };
}

/** The explicit action an exited-agent card asks the application to take. */
export type AgentRestartMode = "resume" | "fresh";
