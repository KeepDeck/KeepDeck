import type { Whereabouts } from "./store";
import type { Generation } from "./version";

/**
 * Whether a pane's opencode may open a recorded session — the one rule a
 * resume and a fork share (task-378, task-460):
 *
 *   never let opencode open a session it cannot find as something else.
 *
 * One store holds two table sets, and each opencode reads only its own
 * (historyMerge.ts). History shows both, so a session the pane's opencode
 * does not have is one click away — and what that opencode does with it is
 * worse than a refusal:
 *
 * - 2.x given a session only 1.x has: `-s` makes an EMPTY session under that
 *   id. Once the copy to 2.x is done, the 1.x conversation is shadowed for
 *   good; while the copy is still running, it later DELETES the turns typed
 *   into the empty one (measured live, task-460).
 * - 1.x given a session 2.x went on with: it opens the half from before the
 *   copy, and the two halves part ways.
 * - 1.x given a session only 2.x has: it exits, and a restore turns that into
 *   a fresh conversation in place of the bound one.
 *
 * So the plugin answers first, before anything starts. A session in neither
 * table set is left to opencode when opencode says so itself (1.x exits, a
 * fork's export fails) — only a 2.x resume would make one up instead.
 */

/** What the store says about one session, for a pane of one generation. */
export type Verdict =
  /** In this generation's tables, and not gone on with in the other's. */
  | "here"
  /** In neither table set. */
  | "nowhere"
  /** Only in the 1.x tables, on a 2.x pane, and the copy has not got there. */
  | "copy-pending"
  /** Only in the other generation's tables. */
  | "other-generation"
  /** In both, and the other generation's half is the newer one. */
  | "continued-elsewhere";

export function verdictOn(generation: Generation, where: Whereabouts): Verdict {
  const mine = generation === 2 ? where.v2 : where.v1;
  const theirs = generation === 2 ? where.v1 : where.v2;
  if (mine) return theirs && theirs.updated > mine.updated ? "continued-elsewhere" : "here";
  if (!theirs) return "nowhere";
  // Only 1.x has it. 2.x copies 1.x's sessions itself, in the background of
  // any 2.x start, and has not reached this one yet — or has finished, and
  // this one was made by 1.x afterwards.
  if (generation === 2 && where.migration.state !== "completed") return "copy-pending";
  return "other-generation";
}

/** The pane's opencode, in the user's words: its release, or its line. */
export const releaseName = (generation: Generation, cliVersion: string | undefined) =>
  `opencode ${cliVersion ?? `${generation}.x`}`;

/** The words for a session the pane's opencode does not have. */
export const missingFrom = (
  generation: Generation,
  cliVersion: string | undefined,
  sessionId: string,
) => `${releaseName(generation, cliVersion)} has no session ${sessionId}.`;

/** Why the session cannot be opened here — `undefined` when it can. */
export function refusalOf(
  verdict: Verdict,
  generation: Generation,
  cliVersion: string | undefined,
  sessionId: string,
): string | undefined {
  const here = releaseName(generation, cliVersion);
  const other = generation === 2 ? "opencode 1.x" : "opencode 2.x";
  switch (verdict) {
    case "here":
      return undefined;
    case "nowhere":
      return missingFrom(generation, cliVersion, sessionId);
    case "copy-pending":
      return (
        `${here} has not copied this 1.x conversation yet. The copy runs whenever any opencode 2.x ` +
        "starts — another opencode pane, or opencode opened once in a terminal — not this one. " +
        "Try again when it has finished."
      );
    case "other-generation":
      return `This conversation was recorded by ${other}, but this pane runs ${here}. Open it with ${other}.`;
    case "continued-elsewhere":
      return `This conversation was continued in ${other}, but this pane runs ${here}. Open it with ${other}.`;
  }
}
