/**
 * When a message may reach its pane, and when a chain has to stop.
 *
 * Pure by construction: every answer here is a function of the message, the
 * receiver's OBSERVED activity and the clock. Queues, timers, retries and
 * the writing itself belong to the application owner — which is what lets
 * these rules be tested without a deck, a PTY or a running agent.
 */
import type { PaneActivity } from "../status";
import type { Mail, MailKind, MailSender } from "./message";
import { isLeadAddress } from "./roles";

export interface MailLimits {
  /** How long a message stays worth delivering after it was spoken. */
  undeliveredMs: number;
  /** How many mail-caused wakes ONE chain may spend. */
  maxHops: number;
  /** How long to hope the receiver takes a turn of its own before spending
   * one on it. At a turn boundary the agent asks the deck what is waiting
   * and the message rides in free; past this, the deck nudges the pane into
   * a turn instead — which delivers just as properly and costs one. */
  hookWaitMs: number;
}

/**
 * The shipped bounds.
 *
 * `undeliveredMs` — five minutes is long enough for a person to answer a
 * permission prompt they are actually looking at, and short enough that a
 * course correction ("stop, don't do that") cannot land after the thing was
 * already approved. That case is the whole reason a held message needs a
 * clock: late is worse than never, because never can be reported back.
 *
 * `maxHops` — a real exchange is a handful of turns (task → question →
 * answer, maybe twice). Eight lets that finish while stopping a runaway
 * A↔B loop within seconds. It is a COST bound before it is a correctness
 * one: every hop is a turn somebody pays for, and nothing else in the
 * system stops two agents from politely answering each other forever —
 * claude's `stop_hook_active` guards one agent against its own hook and
 * cannot see the other agent at all.
 *
 * `hookWaitMs` — 45 seconds buys a free ride often enough to be worth it (a
 * teammate mid-task reaches a boundary well inside it) without making a
 * message to an idle agent feel lost. It is a COST knob, not a correctness
 * one: waiting longer is cheaper and slower, waiting less is the reverse,
 * and either way the message arrives through the same labelled channel. It
 * must stay well under `undeliveredMs`, or the nudge would never get a turn
 * before the message aged out.
 */
export const MAIL_LIMITS: MailLimits = {
  undeliveredMs: 5 * 60_000,
  maxHops: 8,
  hookWaitMs: 45_000,
};

/** Why a message is still sitting undelivered. Both resolve on their own —
 * one when the user answers, one when the process reports — which is why
 * neither is a failure. */
export type MailHoldReason =
  /** The pane is parked on a permission prompt. */
  | "permission"
  /** The pane has no live input channel — it is starting, or stopped. The
   * delivery channel says so; nothing else can. */
  | "no-channel"
  /** This agent asks the deck for its mail at a turn boundary. Waiting buys
   * a labelled envelope instead of a paste that reads like the user typed
   * it — and that a TUI may not even submit. */
  | "turn-boundary"
  /** This message may only arrive labelled, and the labelled channel has
   * not asked yet. See [`WAKES_A_PANE`]. */
  | "labelled-only";

/**
 * The message kinds that may be pushed into a pane's TERMINAL.
 *
 * The split is what a message is FOR. A task, a question, an answer or a
 * note is one agent talking to another and carrying an expectation — the
 * point of it is that the receiver ACTS on it, so waking an idle pane by
 * typing into it is a crude channel but an honest one. So is a delivery
 * report: it goes back to a pane that is waiting for an answer, to tell it
 * to stop waiting, and unblocking someone is a wake by definition.
 *
 * A briefing is none of that. It states where a pane STANDS, and it belongs
 * in the agent's CONTEXT, not in its composer. Pasted, it arrives looking
 * like something the user typed — the exact wrong reading, since the whole
 * content of a briefing is "this did not come from your human". Observed
 * live: a freshly started teammate sat with its briefing in the input box,
 * unsent, and its first act would have been to guess what the person wanted
 * with it. Not delivering it is better than that, so a briefing waits for
 * the labelled channel and expires if that channel never asks.
 */
const WAKES_A_PANE: ReadonlySet<MailKind> = new Set<MailKind>([
  "task",
  "question",
  "answer",
  "note",
  "undelivered",
]);

export type MailVerdict =
  /** Push the message itself into the pane's terminal. Only for an agent
   * with no labelled channel at all — for everyone else, see `wake`. */
  | { kind: "deliver" }
  /**
   * Nudge the pane into taking a turn, and leave the message where it is.
   *
   * The terminal's ONE remaining job for an agent that can receive mail
   * properly. A turn beginning fires the hook that asks the deck what is
   * waiting, and the message then arrives through the labelled channel —
   * so the crude channel carries a wake and never the words.
   *
   * That split is what makes a lost keystroke survivable. Pushing the
   * message itself meant the submit could fail and leave a teammate's task
   * sitting in a composer, unsent, looking to the deck exactly like a
   * delivery: observed twice on claude. A wake that fails to submit loses a
   * nudge, and the message is still in the queue for the next turn.
   */
  | { kind: "wake" }
  | { kind: "hold"; reason: MailHoldReason }
  /** Too old to be worth landing; goes back to the sender undelivered. No
   * reason field — there is one way to expire, and nothing branches on it. */
  | { kind: "expire" };

/**
 * What to do with `mail` RIGHT NOW, given what the receiver is doing.
 *
 * Called on every wake-up — a new message, a status change, a timer tick —
 * so it must answer from its arguments alone and never remember anything.
 */
export function decideDelivery(
  mail: Mail,
  activity: PaneActivity | undefined,
  now: number,
  limits: MailLimits = MAIL_LIMITS,
  /** Whether this pane's agent ASKS the deck for its mail when a turn ends.
   * False for a CLI with no such hook, and for one whose plugin does not
   * render mail — either way the terminal is the only way in. */
  asksAtTurnEnd = false,
): MailVerdict {
  // Expiry is judged BEFORE deliverability, and the order is the rule, not
  // an accident: the case that matters is a held message whose pane just
  // became reachable. Delivering it then is exactly the failure the clock
  // exists to prevent — the correction arrives after the action it was
  // meant to stop.
  if (now - mail.at >= limits.undeliveredMs) return { kind: "expire" };
  // The one genuinely dangerous state, and it outranks everything below. A
  // permission prompt answers keystrokes by CHOOSING A MENU ITEM, so text
  // pushed there is not read as text at all — its characters answer the
  // prompt, and the tracker cannot see that happen, because a write like
  // this deliberately never enters the keystroke channel
  // (`src/app/paneKeys.ts`). Holding is the only safe answer, and it is why
  // messages need a clock at all.
  //
  // No activity at all is NOT this state, and treating it as any kind of
  // hold was once a bug of its own: a status reporter speaks on turn events,
  // so a pane sitting idle at its prompt reports nothing whatsoever.
  if (activity?.state === "waiting" && activity.reason === "permission") {
    return { kind: "hold", reason: "permission" };
  }
  // A message that may only arrive labelled never touches the terminal —
  // not as content, and not as a nudge either. A briefing is pure context:
  // spending a keystroke to make an agent take a turn and come asking for
  // it is the same intrusion in a thinner disguise, and when the keystroke
  // does not land it leaves KeepDeck's own words sitting in somebody's
  // composer. Observed on two panes at once, which is how this rule got its
  // teeth.
  //
  // What makes that safe rather than a hole is `SessionStart`: a starting
  // agent asks the deck during its own boot, so the briefing it could never
  // have been nudged into arrives before its first turn, unprompted.
  if (!WAKES_A_PANE.has(mail.kind)) {
    return { kind: "hold", reason: "labelled-only" };
  }
  // An agent with NO labelled channel has the terminal or nothing.
  if (!asksAtTurnEnd) return { kind: "deliver" };
  // Waiting is only worth anything when a boundary is actually coming. A
  // RUNNING turn will reach one on its own and the message rides it for
  // free; nothing else will, because an idle agent fires no hook at all.
  //
  // Measured: a lead stopped 11 seconds before its team's three answers
  // arrived, and every one of them then sat the full wait — 45 seconds of
  // nothing, ending in the nudge that could have been sent at once.
  //
  // This condition was here before and was removed for a real reason: back
  // then the alternative was pushing the message into the terminal, which
  // is unlabelled and does not reliably arrive, so waiting was worth it even
  // when nothing was coming. The alternative is now a nudge that produces a
  // proper delivery, and the trade reverses with it.
  if (activity?.state === "working" && now - mail.at < limits.hookWaitMs) {
    return { kind: "hold", reason: "turn-boundary" };
  }
  // Nudge the pane into a turn and let ITS OWN channel carry the words. The
  // message stays where it is: the terminal's job here is to wake, never to
  // deliver.
  return { kind: "wake" };
}

/**
 * The delivery report owed to the sender of a message that aged out, or null
 * when none is owed.
 *
 * §7's rule with its teeth in: an expired message goes BACK to its sender as
 * undelivered rather than quietly landing late. Two messages earn no report
 * and both would be a bug if they did — a report about a report is a chain
 * that feeds itself, and a host notice has no pane to report to.
 *
 * The hop is COPIED, never incremented. A report is the mail system
 * accounting for itself; letting it advance the counter would spend a
 * sender's chain budget on news it never asked for.
 *
 * `id` and `at` come from the caller because minting and clock-reading are
 * the owner's, not the rule's — which is what keeps this testable.
 */
export function expiryNotice(mail: Mail, id: string, at: number): Mail | null {
  if (mail.from.kind !== "pane" || mail.kind === "undelivered") return null;
  return {
    id,
    kind: "undelivered",
    body: `Undelivered: your ${mail.kind} did not reach its pane within the delivery window, and has been dropped.`,
    from: { kind: "host" },
    toPaneId: mail.from.pane.paneId,
    at,
    replyTo: mail.id,
    hop: mail.hop,
  };
}

/** Why a send was refused. Typed rather than prose: rendering a refusal for
 * the calling agent is the command layer's job, the same split
 * `resumeRefusalText` already draws. */
export type SendRefusal = "self-addressed" | "hop-limit" | "not-yours-to-assign";

export type SendVerdict =
  /** Accepted, carrying the hop this message is stamped with. */
  | { kind: "accept"; hop: number }
  | { kind: "refuse"; refusal: SendRefusal };

/**
 * Whether `from` may send to `toPaneId`, and at which hop.
 *
 * `inheritedHop` is the hop of the message that WOKE the sender, or null
 * when nothing did — a pane acting on its own opens a fresh chain. Doing the
 * arithmetic here rather than at the call site keeps "what continues a
 * chain" in one place; a caller that computed it would be free to get it
 * wrong and the bound would quietly stop binding.
 */
export function decideSend(
  from: MailSender,
  toPaneId: string,
  inheritedHop: number | null,
  limits: MailLimits = MAIL_LIMITS,
  /** What is being sent. Only `task` is restricted, and only on a team. */
  kind: MailKind = "note",
): SendVerdict {
  // A pane mailing itself wakes itself, forever, for money. There is no
  // legitimate shape of it — anything an agent wants to tell itself, it can
  // simply keep thinking.
  if (from.paneId === toPaneId) return { kind: "refuse", refusal: "self-addressed" };
  // A task is a WORK ORDER, and on a team exactly one member gives those.
  // This is the rule that makes "lead" mean something rather than describe
  // something: told-but-unenforced, the hierarchy lasts until the first
  // agent decides it disagrees. A sender on no team is under no hierarchy
  // and keeps the behaviour it had before teams existed.
  if (kind === "task" && from.role !== undefined && !isLeadAddress(from.role)) {
    return { kind: "refuse", refusal: "not-yours-to-assign" };
  }
  const hop = inheritedHop === null ? 0 : inheritedHop + 1;
  if (hop > limits.maxHops) return { kind: "refuse", refusal: "hop-limit" };
  return { kind: "accept", hop };
}
