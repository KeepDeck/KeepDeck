/**
 * Who may speak for a pane.
 *
 * A reporter proves itself with the bridge secret its spawn was handed. That
 * secret travels in the environment, and the environment is inherited by the
 * pane's WHOLE process tree — so it proves "something running under this
 * pane", never "this pane's agent session". Everything else in here exists
 * because those two are not the same thing: a nested agent CLI, or a second
 * session of the same agent (a teammate, a `--print` run started from a tool
 * call), holds a perfectly valid secret and would otherwise rebind the pane
 * to a conversation the user is not having.
 *
 * Three rules separate them, and none subsumes the others:
 *
 *  - a report may only speak for a pane running the SAME agent — which
 *    catches a foreign CLI on its very first report;
 *  - once a generation has bound, only the process that bound it may rebind —
 *    which catches a nested run of the pane's OWN agent whatever word it
 *    reports, including one claiming to be a continuation;
 *  - within that one process, a pane binds at most ONE fresh session — which
 *    catches an in-process teammate or subsession, where there is no process
 *    boundary left to see.
 *
 * All three are decided here, on plain values, so the rule can be read and
 * tested without a deck, a bridge or a process.
 */

/** What a binding means for the pane's identity, in the deck's own terms. */
export type BindingOrigin =
  /** A session that has just come into existence. */
  | "startup"
  /** The pane's existing conversation continuing under a new id — a resume,
   * a `/clear`, a compaction, a fork. */
  | "swap";

/**
 * Whether a reporter proved itself with THIS pane's secret. A pane that armed
 * no reporter has no secret and therefore matches nothing — an inbox file is
 * not evidence on its own.
 */
export function secretMatches(
  paneSecret: string | undefined,
  reported: string,
): boolean {
  return paneSecret !== undefined && paneSecret !== "" && paneSecret === reported;
}

/**
 * Whether a report claiming to come from `reported` may speak for a pane
 * running `expected`. Shared by every lane the bridge carries — identity,
 * usage and status all correlate by pane and all inherit the same secret.
 *
 * An unattributed report (a reporter older than the field) is refused rather
 * than trusted: the pane keeps what it has, which is recoverable, instead of
 * taking a claim nobody signed.
 */
export function speaksForPane(
  expected: string | undefined,
  reported: string | undefined,
): boolean {
  return (
    expected !== undefined && reported !== undefined && expected === reported
  );
}

/** Why a binding was refused — one reason per rule, so a log line says which
 * rule spoke rather than only that something did. */
export type BindingRefusal =
  /** The secret is not this pane's: not a KeepDeck-spawned reporter at all. */
  | "wrong-token"
  /** A different CLI than the one this pane runs. */
  | "foreign-agent"
  /** A different PROCESS than the one that bound this generation: a nested
   * run of the same CLI, whatever word it reports. */
  | "foreign-process"
  /** A second fresh session inside one process generation, from the SAME
   * process: an in-process teammate or subsession. */
  | "second-startup";

export type BindingVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly refusal: BindingRefusal };

export interface BindingClaim {
  /** The secret this pane's own spawn handed its reporters; absent when the
   * pane armed none, which accepts nothing. */
  readonly paneSecret: string | undefined;
  readonly reportedSecret: string;
  /** The agent the pane runs, and the one the reporter says it is. The
   * reported side is not optional: the bridge refuses an unsigned binding, so
   * by the time a claim exists somebody has signed it. */
  readonly paneAgent: string | undefined;
  readonly reportedAgent: string;
  readonly origin: BindingOrigin;
  /** Whether the pane's CURRENT process generation has already bound a
   * session. Reset by a respawn, not by a rebind. */
  readonly boundThisGeneration: boolean;
  /** The reporting process pinned when this generation bound, and the one
   * reporting now. Undefined on either side means the question cannot be
   * asked — a reporter too old to answer, or a `ps` that could not — and the
   * origin rule below carries the weight alone. */
  readonly boundReporter: string | undefined;
  readonly reportedReporter: string | undefined;
}

/**
 * The whole binding rule, in the order that gives the most specific reason:
 * an unknown secret is not our reporter at all, an unsigned one cannot be
 * placed, a foreign agent is placed but wrong, and only then does the
 * one-fresh-session-per-generation rule get to speak.
 */
export function bindingVerdict(claim: BindingClaim): BindingVerdict {
  const refuse = (refusal: BindingRefusal): BindingVerdict => ({
    accepted: false,
    refusal,
  });
  if (!secretMatches(claim.paneSecret, claim.reportedSecret)) {
    return refuse("wrong-token");
  }
  if (!speaksForPane(claim.paneAgent, claim.reportedAgent)) {
    return refuse("foreign-agent");
  }
  // A different process than the one this generation bound is somebody else's
  // session whatever it calls itself — this is the rule that catches a nested
  // `--resume`, which reports a continuation and would otherwise walk past
  // the origin check below.
  if (
    claim.boundReporter !== undefined &&
    claim.reportedReporter !== undefined &&
    claim.boundReporter !== claim.reportedReporter
  ) {
    return refuse("foreign-process");
  }
  // Same process, second fresh session: an in-process teammate or subsession.
  if (claim.origin === "startup" && claim.boundThisGeneration) {
    return refuse("second-startup");
  }
  return { accepted: true };
}
