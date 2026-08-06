/**
 * When a message may reach its pane, and when a chain has to stop.
 *
 * Pure by construction: every answer here is a function of the message, the
 * receiver's OBSERVED activity and the clock. Queues, timers, retries and
 * the writing itself belong to the application owner — which is what lets
 * these rules be tested without a deck, a PTY or a running agent.
 */
import type { PaneActivity } from "../status";
import type { Mail, MailSender } from "./message";

export interface MailLimits {
  /** How long a message stays worth delivering after it was spoken. */
  undeliveredMs: number;
  /** How many mail-caused wakes ONE chain may spend. */
  maxHops: number;
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
 */
export const MAIL_LIMITS: MailLimits = {
  undeliveredMs: 5 * 60_000,
  maxHops: 8,
};

/** Why a message is still sitting undelivered. Both resolve on their own —
 * one when the user answers, one when the process reports — which is why
 * neither is a failure. */
export type MailHoldReason =
  /** The pane is parked on a permission prompt. */
  | "permission"
  /** Nothing is reporting activity for this pane yet. */
  | "not-reporting";

export type MailVerdict =
  | { kind: "deliver" }
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
): MailVerdict {
  // Expiry is judged BEFORE deliverability, and the order is the rule, not
  // an accident: the case that matters is a held message whose pane just
  // became reachable. Delivering it then is exactly the failure the clock
  // exists to prevent — the correction arrives after the action it was
  // meant to stop.
  if (now - mail.at >= limits.undeliveredMs) return { kind: "expire" };
  // No activity means one of two things and there is no need to tell them
  // apart: the pane is starting (status lands a beat after the process) or
  // it is suspended and never will report. Holding serves both — the first
  // resolves itself, the second expires above and is reported back.
  if (!activity) return { kind: "hold", reason: "not-reporting" };
  // The one genuinely dangerous state. A permission prompt answers
  // keystrokes by CHOOSING A MENU ITEM, so text pushed there is not read as
  // text at all — its characters answer the prompt, and the tracker cannot
  // see that happen, because a write like this deliberately never enters the
  // keystroke channel (`src/app/paneKeys.ts`). Holding is the only safe
  // answer, and it is why messages need a clock at all.
  if (activity.state === "waiting" && activity.reason === "permission") {
    return { kind: "hold", reason: "permission" };
  }
  // Everything else takes it. `working` is steering — a correction mid-run
  // is the normal mode, not an intrusion. `waiting("question")` is a pane
  // parked on a question, where the message is most likely the answer.
  // `done`/`failed` simply start a new turn.
  return { kind: "deliver" };
}

/** Why a send was refused. Typed rather than prose: rendering a refusal for
 * the calling agent is the command layer's job, the same split
 * `resumeRefusalText` already draws. */
export type SendRefusal = "self-addressed" | "hop-limit";

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
): SendVerdict {
  // A pane mailing itself wakes itself, forever, for money. There is no
  // legitimate shape of it — anything an agent wants to tell itself, it can
  // simply keep thinking.
  if (from.paneId === toPaneId) return { kind: "refuse", refusal: "self-addressed" };
  const hop = inheritedHop === null ? 0 : inheritedHop + 1;
  if (hop > limits.maxHops) return { kind: "refuse", refusal: "hop-limit" };
  return { kind: "accept", hop };
}
