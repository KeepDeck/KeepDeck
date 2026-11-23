/**
 * Who asked for a continuation, and what an exited pane's card may ask for.
 *
 * Product vocabulary, not mechanism: the origin of a resume decides whether a
 * session that turns out to be gone may silently become a DIFFERENT
 * conversation — only boot restoration may, because nobody is watching, while
 * a resume the user asked for by name has to stay visibly refused. Either may
 * be tried once more on the SAME conversation first: an agent can refuse a
 * resume for a moment and take it a second later. That rule outlives any
 * CLI's flags and would still hold if the deck were driven from a terminal,
 * which is what puts it here.
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

/** What to do with a resume the CLI refused — it died before it became a
 * session — the ONE decision this module owns for that exit. */
export type RejectedResumeAction =
  /** Held by an outside process: the binding stays, the pane offers the
   * person a choice (fork a copy, leave it). */
  | { kind: "keep"; registry: "live" | "unknown" }
  /** One quiet retry on the same conversation. A refusal is not proof the
   * conversation is gone: an agent can refuse a resume for a moment (one
   * that finished between the refusal and the registry's answer, one that
   * tripped over its own write while restoring) and take it a second
   * later. Only the retry's own silent death is evidence. */
  | { kind: "retry-once" }
  /** The old behavior, whole: drop the binding, one automatic fresh
   * spawn — the recorded session really is gone. Boot restoration only. */
  | { kind: "legacy-fresh" }
  /** A resume the person asked for, refused again after its retry: the
   * pane stays exited on its conversation, and its exit is said as any
   * other — the page does not take it over. */
  | { kind: "leave" };

/** Whether the page takes a refused resume over at all — the part of the
 * decision no registry answer changes. A resume the person asked for is
 * taken over for its one retry and no further. */
export function takesOverRejectedResume(origin: ResumeOrigin, alreadyRetried: boolean): boolean {
  return origin === "restore" || !alreadyRetried;
}

/**
 * Decide a refused resume from who asked for it, what the registry said,
 * and whether this was already its retry.
 *
 * The rule this replaces read a silent CLI refusal as "the session is
 * gone" — sound when refusals had three causes (deleted, GC'd, never
 * materialized), wrong the day a fourth appeared: the session exists and
 * is BUSY. The registry, not the refusal text, is the source of truth.
 *
 * UNKNOWN is treated like LIVE, deliberately: erasing a binding on
 * unknown risks the exact harm this rule exists to end (a live
 * conversation lost), while keeping a dead one costs a visible pane with
 * a choice. The asymmetry is the point. No registry at all — the agent
 * has none, or its answer never came — is not a claim either way, and
 * earns the retry like "absent": one transient refusal must never cost a
 * conversation.
 *
 * A resume the user asked for by name never becomes another conversation,
 * whatever the registry says: its one retry, then it stays visibly down.
 * `alreadyRetried` is how the one quiet retry stays one: it is the same
 * marker the retry's own plan carries.
 */
export function decideRejectedResume(
  origin: ResumeOrigin,
  answer: LiveRegistryAnswer | null,
  alreadyRetried: boolean,
): RejectedResumeAction {
  if (!takesOverRejectedResume(origin, alreadyRetried)) return { kind: "leave" };
  if (origin === "manual") return { kind: "retry-once" };
  if (answer === "live") return { kind: "keep", registry: "live" };
  if (answer === "unknown") return { kind: "keep", registry: "unknown" };
  return alreadyRetried ? { kind: "legacy-fresh" } : { kind: "retry-once" };
}

/** The explicit action an exited-agent card asks the application to take. */
export type AgentRestartMode = "resume" | "fresh";
