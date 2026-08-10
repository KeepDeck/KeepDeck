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
 *  - a FRESH session may only come from the process that bound this
 *    generation — which catches a nested run of the pane's own agent booting
 *    a conversation of its own;
 *  - within that one process, a pane binds at most ONE fresh session — which
 *    catches an in-process teammate or subsession, where there is no process
 *    boundary left to see.
 *
 * A CONTINUATION is deliberately exempt from the process rule, because the
 * pane's own agent can change process without ending its conversation:
 * claude answers a full context window by re-hosting the session in its own
 * daemon (`--fork-session --resume` of the transcript it was already on),
 * under a new process group, and every later report comes from there. Holding
 * the pin against that refuses the pane's own agent for the rest of its life —
 * measured in the field, and the cost is total, since both bridge lanes share
 * this rule. Nothing in the tree can tell that re-host from a nested
 * `--resume`: both are descendants of the pane's first process. So the word
 * decides, and what it buys is bounded by who can say it — a nested run needs
 * the spawn's injected settings to report at all.
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

/**
 * Whether a report comes from the process this pane's generation is pinned
 * to. Either side silent means the question cannot be asked — a reporter too
 * old to answer, or a `ps` that could not — and the caller falls back to the
 * rules that need no process.
 *
 * Shared by the binding rule and the report lanes, because the secret they
 * both authenticate with is inherited by the pane's whole process tree: a
 * guard on one lane and not the other is how a refused session keeps
 * reporting through the weaker one.
 */
export function sameProcess(
  pinned: string | undefined,
  reported: string | undefined,
): boolean {
  return pinned === undefined || reported === undefined || pinned === reported;
}

/** Why a binding was refused — one reason per rule, so a log line says which
 * rule spoke rather than only that something did. */
export type BindingRefusal =
  /** The secret is not this pane's: not a KeepDeck-spawned reporter at all. */
  | "wrong-token"
  /** A different CLI than the one this pane runs. */
  | "foreign-agent"
  /** A FRESH session from a different PROCESS than the one that bound this
   * generation: a nested run of the same CLI starting its own conversation. */
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
 * placed, a foreign agent is placed but wrong, and only then do the two rules
 * about a FRESH session get to speak.
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
  // The pane's conversation continuing is the one claim whose process may
  // legitimately differ (see the header): the agent re-hosts the SAME
  // conversation elsewhere, and refusing it strands the pane on a process
  // that has stopped speaking. The caller moves the pin to the process that
  // sent it, so the exemption spans one binding and the report lanes follow.
  // Where either side cannot be named the pin never discriminated at all, and
  // nothing here changes that.
  if (claim.origin === "swap") return { accepted: true };
  // From here it is a fresh session, and both remaining rules are about one:
  // a different process than the one this generation bound is a nested run
  // booting its own conversation...
  if (!sameProcess(claim.boundReporter, claim.reportedReporter)) {
    return refuse("foreign-process");
  }
  // ...and the same process starting a second one is an in-process teammate
  // or subsession, where no process boundary is left to see it by.
  if (claim.boundThisGeneration) {
    return refuse("second-startup");
  }
  return { accepted: true };
}
