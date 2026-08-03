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

/** The explicit action an exited-agent card asks the application to take. */
export type AgentRestartMode = "resume" | "fresh";
