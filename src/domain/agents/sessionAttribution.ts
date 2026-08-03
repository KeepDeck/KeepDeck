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
 * Two rules separate them, and neither subsumes the other:
 *
 *  - a report may only speak for a pane running the SAME agent — which
 *    catches a foreign CLI on its very first report;
 *  - a pane binds at most ONE fresh session per process generation — which
 *    catches a second session of its own agent, whatever spawned it.
 *
 * Both are decided here, on plain values, so the rule can be read and tested
 * without a deck, a bridge or a process.
 */

/** What a binding means for the pane's identity, in the deck's own terms. */
export type BindingOrigin =
  /** A session that has just come into existence. */
  | "startup"
  /** The pane's existing conversation continuing under a new id — a resume,
   * a `/clear`, a compaction, a fork. */
  | "swap";

/**
 * The words our agents actually report for a swap. This is the union of
 * their vocabularies rather than a per-agent map because, today, there is
 * nothing to disagree about: claude defined the words, codex and kimi copied
 * its hooks design, and opencode's reporter emits `new` for its one
 * mid-life case. An agent that speaks differently earns a per-agent seam;
 * inventing one before then would be an abstraction over a single case.
 */
const SWAP_WORDS: ReadonlySet<string> = new Set([
  "resume",
  "clear",
  "compact",
  "fork",
  "new",
]);

/**
 * The CLI's own word for why a session started, read as one bit.
 *
 * Anything unrecognised — a word from a newer CLI, a field the reporter could
 * not fill, a reporter too old to send one — reads as `startup`, the STRICT
 * side: an unrecognised binding can then only be refused as a second start,
 * never accepted as a continuation. Guessing the other way would hand every
 * unknown word the one verdict that overwrites the pane's identity.
 */
export function bindingOrigin(source: string | undefined): BindingOrigin {
  return source !== undefined && SWAP_WORDS.has(source) ? "swap" : "startup";
}

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
  /** Nobody signed it — a reporter that predates attribution. */
  | "unattributed"
  /** A different CLI than the one this pane runs. */
  | "foreign-agent"
  /** A second fresh session inside one process generation: the pane's own
   * agent already bound, and a brand-new session is therefore somebody
   * else's — a teammate, a nested run. */
  | "second-startup";

export type BindingVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly refusal: BindingRefusal };

export interface BindingClaim {
  /** The secret this pane's own spawn handed its reporters; absent when the
   * pane armed none, which accepts nothing. */
  readonly paneSecret: string | undefined;
  readonly reportedSecret: string;
  /** The agent the pane runs, and the one the reporter says it is. */
  readonly paneAgent: string | undefined;
  readonly reportedAgent: string | undefined;
  readonly origin: BindingOrigin;
  /** Whether the pane's CURRENT process generation has already bound a
   * session. Reset by a respawn, not by a rebind. */
  readonly boundThisGeneration: boolean;
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
  if (claim.reportedAgent === undefined) return refuse("unattributed");
  if (!speaksForPane(claim.paneAgent, claim.reportedAgent)) {
    return refuse("foreign-agent");
  }
  if (claim.origin === "startup" && claim.boundThisGeneration) {
    return refuse("second-startup");
  }
  return { accepted: true };
}
