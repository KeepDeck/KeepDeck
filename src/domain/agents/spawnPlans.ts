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
 * session — once the page has taken it over. */
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
  | { kind: "legacy-fresh" };

/** What the page does next with a resume that died before it became a
 * session — the ONE decision this module owns for that exit. */
export type RejectedResumeNext =
  /** Not taken over: the pane stays exited on its conversation, and its
   * exit is said as any other. */
  | { kind: "leave" }
  /** Taken over, and decided already. */
  | { kind: "act"; action: RejectedResumeAction }
  /** Taken over; the agent's live-session registry is asked, and
   * [`decideRejectedResume`] decides from its answer. */
  | { kind: "ask-registry" };

/**
 * What a resume that died before it became a session earns, by who asked
 * for it, whether this was already its retry, and whether its process
 * failed.
 *
 * A boot restore is the registry's to decide: nobody is watching, and only
 * it may become another conversation. A resume the person asked for by
 * name never does, whatever the registry says, so the registry is not
 * asked: a failed one gets its one quiet retry on the same conversation,
 * then stays visibly down. One that ended cleanly was ended on purpose —
 * the person quit it while it was still restoring — and is left alone. A
 * kill by a signal cannot be told from a crash here; both read as failed.
 */
export function rejectedResumeNext(
  origin: ResumeOrigin,
  alreadyRetried: boolean,
  failed: boolean,
): RejectedResumeNext {
  if (origin === "restore") return { kind: "ask-registry" };
  if (!failed || alreadyRetried) return { kind: "leave" };
  return { kind: "act", action: { kind: "retry-once" } };
}

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
 * a choice. The asymmetry is the point. No registry at all — the agent
 * has none, or its answer never came — is not a claim either way, and
 * earns the retry like "absent": one transient refusal must never cost a
 * conversation. `alreadyRetried` is how the one quiet retry stays one: it
 * is the same marker the retry's own plan carries.
 */
export function decideRejectedResume(
  answer: LiveRegistryAnswer | null,
  alreadyRetried: boolean,
): RejectedResumeAction {
  if (answer === "live") return { kind: "keep", registry: "live" };
  if (answer === "unknown") return { kind: "keep", registry: "unknown" };
  return alreadyRetried ? { kind: "legacy-fresh" } : { kind: "retry-once" };
}

/** The explicit action an exited-agent card asks the application to take. */
export type AgentRestartMode = "resume" | "fresh";
