/**
 * Who may speak for a pane.
 *
 * The bridge's door has proven where a report comes from before the page
 * hears it: the kernel placed its sender in the pane's live terminal — or in
 * a session a process of it started, as an agent runs its hooks — that sender
 * named the pane's bridge secret, and a process it named belongs to that
 * terminal itself (keepdeck-pty `sessions::judge_caller`). That proves
 * "something running under this pane", never "this pane's agent session".
 * Everything else in here exists because those two are not the same thing: a
 * nested agent CLI, or a second session of the same agent (a teammate, a
 * `--print` run started from a tool call), runs in the same terminal and
 * would otherwise rebind the pane to a conversation the user is not having.
 *
 * One rule comes first, and is about the pane rather than the report: a pane
 * takes reports only while it holds a plan that reports. A teardown retires
 * the plan before it stops the process, and the door, which judges by the
 * live terminal, still takes what that process says in between; taken, a
 * binding there would pin a retired generation to the old process.
 *
 * Three rules separate the sessions, and none subsumes the others:
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
 * claude 2.1.226 answered a full context window by re-hosting the session in
 * its own daemon (`--fork-session --resume` of the transcript it was already
 * on), under a new process group, and every later report came from there.
 * Holding the pin against that refused the pane's own agent for the rest of
 * its life — measured in the field, and the cost is total, since both bridge
 * lanes share this rule. So the word decides, and what it buys is bounded by
 * who can say it — a nested run needs the spawn's injected settings to report
 * at all.
 *
 * Bounded further since: the bridge's door refuses a report whose named
 * process does not belong to the pane's terminal itself, and a daemon's
 * worker does not. Claude 2.1.303 compacts in-process and moves a
 * conversation into its daemon only when the user sends it to the background
 * (verified live, task-422) — whose worker then speaks for no pane. What this
 * exemption still admits is a continuation from another process of the
 * pane's terminal.
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
 * Whether a report claiming to come from `reported` may speak for a pane
 * running `expected`. Shared by every lane the bridge carries — identity,
 * usage and status all correlate by pane and all come from its terminal.
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
 * Shared by the binding rule and the report lanes, because both take reports
 * from the pane's whole terminal: a guard on one lane and not the other is
 * how a refused session keeps reporting through the weaker one.
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
  /** The pane holds no plan that reports: it armed none, or a teardown has
   * retired it before stopping the process that still speaks. */
  | "no-plan"
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
  /** Whether the pane holds a plan that reports; none accepts nothing. */
  readonly paneReports: boolean;
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
  /** Whether the agent says a fresh session from the pane's own, already
   * bound process is the user starting a NEW conversation — its `/new` —
   * rather than a second session beside the first. Only the agent can tell
   * (`AgentContribution.binding`); claude cannot, and says nothing. */
  readonly restartsConversation: boolean;
}

/**
 * The whole binding rule, in the order that gives the most specific reason:
 * a pane with no plan that reports takes nothing, a foreign agent is placed
 * but wrong, and only then do the two rules about a FRESH session get to
 * speak.
 */
export function bindingVerdict(claim: BindingClaim): BindingVerdict {
  const refuse = (refusal: BindingRefusal): BindingVerdict => ({
    accepted: false,
    refusal,
  });
  if (!claim.paneReports) {
    return refuse("no-plan");
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
  // or subsession, where no process boundary is left to see it by — unless
  // the agent itself says this one is its user's new conversation. codex and
  // kimi report their `/new` as a fresh start and have no in-process
  // teammates; claude has, and keeps the refusal. Only from a process KNOWN
  // to be the one this generation bound: where either side is silent the
  // process question was never asked, and the agent's word alone would let a
  // nested run through as the user's new conversation.
  const knownSameProcess =
    claim.boundReporter !== undefined && claim.boundReporter === claim.reportedReporter;
  if (claim.boundThisGeneration && !(claim.restartsConversation && knownSameProcess)) {
    return refuse("second-startup");
  }
  return { accepted: true };
}
