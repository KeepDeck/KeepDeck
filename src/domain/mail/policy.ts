/**
 * When a message may reach its pane, and who may write to whom.
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
  /** How long to hope the receiver takes a turn of its own before spending
   * one on it. At a turn boundary the agent asks the deck what is waiting
   * and the message rides in free; past this, the deck nudges the pane into
   * a turn instead — which delivers just as properly and costs one. */
  hookWaitMs: number;
  /** How much teammate BODY text may leave the queue at one turn boundary,
   * in characters.
   *
   * The per-message cap lives with the framing; this is the other half, and
   * it has to live here because only the queue's owner can bound a BATCH
   * without losing anything. Whatever does not fit stays queued for the next
   * ask, so the pane reads its mail over a few turns instead of taking one
   * enormous injection — which is what a sender in a loop produces.
   *
   * Bodies as SENT, not as framed: the queue holds messages, and what a
   * plugin's renderer does with them (a quote marker per line, a header per
   * message, an envelope around the lot) is not visible from here. The framed
   * text is therefore somewhat larger — the same order, not the same
   * number — so this is a bound on what an agent can make another agent
   * read, not an exact byte budget for a request. */
  handoverChars: number;
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
 * `hookWaitMs` — 45 seconds buys a free ride often enough to be worth it (a
 * teammate mid-task reaches a boundary well inside it) without making a
 * message to an idle agent feel lost. It is a COST knob, not a correctness
 * one: waiting longer is cheaper and slower, waiting less is the reverse,
 * and either way the message arrives through the same labelled channel. It
 * must stay well under `undeliveredMs`, or the nudge would never get a turn
 * before the message aged out.
 *
 * `handoverChars` — 32 000 is two full-size messages, or a great many
 * ordinary ones, and it is a CEILING rather than a target: a hand-over
 * always carries at least one message, however long, so nothing can be
 * stuck behind the bound. It exists because the receiver pays for every
 * character in its next turn, and the sender chooses how many there are.
 */
export const MAIL_LIMITS: MailLimits = {
  undeliveredMs: 5 * 60_000,
  hookWaitMs: 45_000,
  handoverChars: 32_000,
};

/** Why a message is still sitting undelivered. Both resolve on their own —
 * one when the user answers, one when the process reports — which is why
 * neither is a failure. */
export type MailHoldReason =
  /** The pane is parked on a permission prompt. */
  | "permission"
  /** This agent asks the deck for its mail at a turn boundary. Waiting buys
   * a labelled envelope instead of a paste that reads like the user typed
   * it — and that a TUI may not even submit. */
  | "turn-boundary"
  /** This message may only arrive labelled, and the labelled channel has
   * not asked yet. See [`isStandingContext`]. */
  | "labelled-only";

/**
 * Whether this kind is standing CONTEXT rather than traffic between agents.
 *
 * One split, and both of the rules that matter fall out of it.
 *
 * TRAFFIC — a task, a question, an answer, a note, a delivery report — is one
 * agent talking to another and carrying an expectation: the point is that the
 * receiver ACTS. So waking an idle pane by typing into it is crude but
 * honest, and so is a clock, because acting late can be worse than not
 * acting at all. "Stop, don't do that" arriving after it was done is the
 * failure the delivery window exists to prevent.
 *
 * CONTEXT — a briefing — is neither. It states where a pane STANDS.
 *
 * It is never typed in. Pasted, it reads as something the person wrote,
 * which is the exact opposite of the only thing it says; and a nudge to make
 * the agent come asking for it is the same intrusion in a thinner disguise.
 * Both were observed leaving KeepDeck's own words in somebody's composer.
 *
 * And it never expires, because it cannot go stale. A briefing is as true an
 * hour later as it was when the team formed — and an agent that takes no
 * turn of its own for an hour is exactly the one that would lose it. Then the
 * first message from a teammate wakes it and arrives WITHOUT the standing it
 * needs to make sense of who is asking. Traffic keeps the clock; context
 * waits as long as it takes.
 */
export function isStandingContext(kind: MailKind): boolean {
  return kind === "team";
}

/**
 * Whether RECEIVING this leaves the reader owing its sender a response.
 *
 * The cut is [`MailKind`]'s own: `task` and `question` interrupt — each
 * expects something back — while `note` merely informs and `answer` closes
 * what the reader itself asked. Only the first two can be outstanding, so
 * only they can be what a later answer is answering.
 *
 * Booking every kind was a defect, not an omission: a teammate's answer, or
 * an unbidden note, became a debt that the reader's next message spent, and
 * an unrelated question shipped labelled as a reply to it.
 */
export function awaitsAnswer(kind: MailKind): boolean {
  return kind === "task" || kind === "question";
}

/**
 * Whether SENDING this closes something the sender was asked.
 *
 * `answer` alone. A `question` back is a response in ordinary speech and the
 * implementer's charter invites one — but the deck cannot tell that question
 * from one opening a subject of its own, and treating both as responses made
 * a new topic spend a debt and arrive labelled as a reply to it. The
 * clarifying question simply gets no edge, which is the direction this whole
 * rule errs in: a missing edge shows somebody still waiting, a wrong one
 * hides it.
 *
 * `team` and `undelivered` are the deck's own voice and never sent by an
 * agent at all, so they fall out on the same side.
 */
export function isResponse(kind: MailKind): boolean {
  return kind === "answer";
}

/**
 * What choosing a kind COSTS, in the words its sender needs.
 *
 * Since [`decideDelivery`] started reading the kind, this is no longer a
 * label on a message — it decides whether a teammate is pulled out of its
 * work. An agent picking one is deciding how to spend somebody else's turn,
 * and "task, question, answer, note" told it none of that.
 *
 * Derived from the predicate rather than written beside it, so the sentence
 * cannot say one thing while the code does another. Two surfaces disagreeing
 * about how mail works is the defect this whole feature keeps producing.
 */
export function kindGuidance(kinds: readonly MailKind[]): string {
  const named = (chosen: readonly MailKind[]) => chosen.join(" and ");
  // Both halves say "while it is working", because that is the only case the
  // kind decides. An IDLE teammate is nudged for anything — it will reach no
  // turn boundary on its own, so waiting for one would mean never arriving.
  // Said without that clause, this promised a sender that notes are free,
  // and idle is the ordinary state of a teammate between tasks.
  return `while a teammate is working, ${named(kinds.filter(awaitsAnswer))} interrupt it and cost it a turn, and ${named(kinds.filter((kind) => !awaitsAnswer(kind)))} wait for the turn boundary it is already heading for. A teammate that is idle is roused for any of them, because nothing else will bring it back.`;
}
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
  | { kind: "hold"; reason: MailHoldReason };

/**
 * Whether `mail` may be handed over at a turn boundary, when the agent has
 * come asking for it.
 *
 * The two clauses it shares with [`decideDelivery`] are shared on purpose —
 * they were copied into the application owner once, and a fifth reason to
 * hold would then have been honoured on the terminal path and ignored on the
 * labelled one, which is the path a briefing exclusively uses.
 *
 * What it does NOT share is the rest: everything below the permission clause
 * in `decideDelivery` decides between the two channels, and this IS the
 * labelled channel. Standing context is the clearest case — held there,
 * delivered here, because this is the moment it was waiting for.
 */
export function decideHandover(activity: PaneActivity | undefined): "hand" | "hold" {
  return parkedOnAPrompt(activity) ? "hold" : "hand";
}

/**
 * Whether `mail` has been waiting long enough that its SENDER should be told.
 *
 * It is a fact about the wait, not a verdict on the message, and that is the
 * whole of the change it records. This clock used to destroy: a message
 * older than the window was dropped and its sender told it never arrived —
 * so a teammate running a ten-minute build lost everything written to it, on
 * the argument that a correction arriving after the action it meant to stop
 * is worse than none.
 *
 * The argument is sound and belongs to the RECEIVER, who alone knows what
 * the message was about; the deck does not. What the deck can do is say when
 * a message it holds has been waiting, and let the receiver read it with its
 * age in view. Nothing is thrown away for being late.
 *
 * Standing context keeps no clock at all ([`isStandingContext`]): an agent
 * that takes no turn for an hour is exactly the one that would otherwise be
 * told its briefing is overdue, when the briefing is what it is missing.
 */
export function isOverdue(
  mail: Mail,
  now: number,
  limits: MailLimits = MAIL_LIMITS,
): boolean {
  return !isStandingContext(mail.kind) && now - mail.at >= limits.undeliveredMs;
}

/**
 * The one genuinely dangerous state, and it outranks everything below it.
 *
 * A permission prompt answers keystrokes by CHOOSING A MENU ITEM, so text
 * pushed there is not read as text at all — its characters answer the
 * prompt, and the tracker cannot see that happen, because a write like this
 * deliberately never enters the keystroke channel (`src/app/paneKeys.ts`).
 * Holding is the only safe answer, and it is why messages need a clock at
 * all. Arriving through a hook does not make answering one safe either: the
 * pane is still parked where keystrokes pick menu items.
 *
 * No activity at all is NOT this state, and treating it as any kind of hold
 * was once a bug of its own: a status reporter speaks on turn events, so a
 * pane sitting idle at its prompt reports nothing whatsoever.
 */
function parkedOnAPrompt(activity: PaneActivity | undefined): boolean {
  return activity?.state === "waiting" && activity.reason === "permission";
}

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
  // No clause for age. A message that has waited too long is a fact its
  // SENDER is told about ([`isOverdue`]) — it is not a reason to stop trying
  // to deliver it, and the receiver is the only party that can judge whether
  // its contents still matter.
  // See [`parkedOnAPrompt`] for why this outranks everything below it.
  if (parkedOnAPrompt(activity)) return { kind: "hold", reason: "permission" };
  // A message that may only arrive labelled never touches the terminal —
  // not as content, and not as a nudge either. A briefing is pure context:
  // spending a keystroke to make an agent take a turn and come asking for
  // it is the same intrusion in a thinner disguise, and when the keystroke
  // does not land it leaves KeepDeck's own words sitting in somebody's
  // composer. Observed on two panes at once, which is how this rule got its
  // teeth.
  //
  // What makes that safe rather than a hole is that it WAITS, without a
  // clock. claude collects it during its own boot, from `SessionStart`. An
  // agent that has no session until somebody speaks to it — kimi — collects
  // it on the turn that first message opens, which is the moment it becomes
  // useful anyway: standing arrives together with the first thing that
  // needs it.
  if (isStandingContext(mail.kind)) {
    return { kind: "hold", reason: "labelled-only" };
  }
  // An agent with NO labelled channel has the terminal or nothing.
  if (!asksAtTurnEnd) return { kind: "deliver" };
  if (activity?.state === "working") {
    // A turn is running, so a boundary is coming by definition and the
    // message can ride it for free. What decides whether it is worth paying
    // for a turn of its own is what the message EXPECTS: [`awaitsAnswer`]
    // is true of exactly the kinds that need something back from this agent,
    // and you spend somebody's turn to ask them for something, not to
    // inform them.
    //
    // Routine mail waits without a clock. The clock used to apply to
    // everything, so a pane still working after the wait fell through to a
    // nudge — into a RUNNING turn, where it lands in the input queue and
    // fires a turn of its own later. A ten-minute build collected one of
    // those every 45 seconds.
    if (!awaitsAnswer(mail.kind)) return { kind: "hold", reason: "turn-boundary" };
    // Something that does expect an answer still waits a little, in case the
    // boundary is near enough that the ride is free after all.
    //
    // Measured: a lead stopped 11 seconds before its team's three answers
    // arrived, and every one of them then sat the full wait — 45 seconds of
    // nothing, ending in the nudge that could have been sent at once. That
    // pane was stopped, not working, which is the branch below.
    if (now - mail.at < limits.hookWaitMs) {
      return { kind: "hold", reason: "turn-boundary" };
    }
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
 * A sender learns that its message is still sitting in a queue, rather than
 * being left to wonder — and, since nothing is dropped for being late, that
 * is all the report says. Two messages earn no report and both would be a
 * bug if they did: a report about a report is a chain that feeds itself, and
 * a host notice has no pane to report to.
 *
 * `id` and `at` come from the caller because minting and clock-reading are
 * the owner's, not the rule's — which is what keeps this testable.
 */
export function overdueNotice(mail: Mail, id: string, at: number): Mail | null {
  return reportToSender(
    mail,
    id,
    at,
    `Still waiting: your ${mail.kind} has not reached its pane yet — it is queued and will land when that agent next takes a turn. Nothing is lost and there is nothing to re-send.`,
  );
}

/**
 * The report owed when a message is dropped to keep a queue bounded.
 *
 * The one way a message is still lost, and it says so plainly. Age is no
 * longer a reason to drop anything ([`isOverdue`]), so what remains is a
 * pane that has taken nothing for so long that its queue would grow without
 * end — and there the oldest goes, because the newest is the one still worth
 * landing.
 */
export function droppedNotice(mail: Mail, id: string, at: number): Mail | null {
  return reportToSender(
    mail,
    id,
    at,
    `Dropped: your ${mail.kind} was never collected, and that agent has so much mail waiting — from everyone, not only you — that the oldest had to go. Re-sending puts you at the back of the same queue; take it up with your user instead.`,
  );
}

/**
 * The report owed when a DELIVERED message falls out of the receiver's
 * journal.
 *
 * Different from [`droppedNotice`] in the one way that matters to a sender:
 * this message arrived. What is gone is the deck's memory of it — so an
 * answer arriving now cannot be tied back to it, and nothing is tracking
 * that it went unanswered. Telling that sender its message was never
 * collected would send it looking for a delivery failure that did not
 * happen, and the honest instruction is the opposite one: ask again.
 */
export function forgottenNotice(mail: Mail, id: string, at: number): Mail | null {
  return reportToSender(
    mail,
    id,
    at,
    `Forgotten: your ${mail.kind} reached that agent and was never answered, and it has been handed so much mail since that the deck no longer tracks it. An answer now will not be tied back to it — ask again if you still need one.`,
  );
}

/** The shape all three reports share. See [`overdueNotice`] for why two of
 * the three possible senders get nothing. */
function reportToSender(mail: Mail, id: string, at: number, body: string): Mail | null {
  if (mail.from.kind !== "pane" || mail.kind === "undelivered") return null;
  return {
    id,
    kind: "undelivered",
    body,
    from: { kind: "host" },
    toPaneId: mail.from.pane.paneId,
    at,
    replyTo: mail.id,
  };
}

/** Why a send was refused. Typed rather than prose: rendering a refusal for
 * the calling agent is the command layer's job, the same split
 * `resumeRefusalText` already draws. */
export type SendRefusal = "self-addressed" | "not-yours-to-assign";

/**
 * Why this send is refused, or null when nothing stands in its way.
 *
 * Both refusals ask who is writing to whom, and neither depends on what came
 * before — which is why this needs no state, no clock and no limits: it is a
 * question about one message, answerable from the message alone.
 *
 * **There is deliberately no bound on how long an exchange may run.** There
 * was one, and what it did is worth recording against its return: a counter
 * a pane inherited from the message that woke it, growing by one per send
 * and refusing past eight.
 *
 * It moved only on RECEIPT, so it counted turnarounds rather than messages —
 * an agent nobody answered could write without limit, while an exchange
 * where both sides actually replied spent the budget fastest. It lived on
 * the pane rather than on the conversation, so unrelated threads shared it
 * and one refusal muted that pane toward the whole deck. It reset on nothing
 * short of the pane's process, so an administrative notice at hop zero was
 * the only thing that ever cleared it. And because the blocked side's
 * silence stopped advancing the other side's counter, its end state was one
 * pane mute for the rest of its life while the other kept sending happily
 * into it — the exact opposite of what a loop guard should produce. A team
 * left to work unattended, which is the point of the feature, reached it on
 * the ninth message.
 *
 * The risk it was aimed at is real: two agents can politely answer each
 * other all night, and each CLI's own guard sees only itself. But that is a
 * question of SPEND, and spend is not counted in messages — nor is mail the
 * only way to burn it, since nothing here bounds a tool loop or a
 * forty-minute build. It belongs where the deck already counts tokens, not
 * in the rules about who may write to whom.
 *
 * Said plainly, because "belongs elsewhere" reads too easily as "handled
 * elsewhere": nothing implements it today. The deck warns on a provider's
 * usage window and stops nothing, here or anywhere else. That is the same
 * position mail was already in — the counter never bounded volume, only
 * turnarounds — but it is a gap, not a delegation.
 */
export function sendRefusal(
  from: MailSender,
  toPaneId: string,
  /** What is being sent. Only `task` is restricted, and only on a team. */
  kind: MailKind = "note",
): SendRefusal | null {
  // A pane mailing itself wakes itself, forever, for money. There is no
  // legitimate shape of it — anything an agent wants to tell itself, it can
  // simply keep thinking.
  if (from.paneId === toPaneId) return "self-addressed";
  // A task is a WORK ORDER, and on a team exactly one member gives those.
  // This is the rule that makes "lead" mean something rather than describe
  // something: told-but-unenforced, the hierarchy lasts until the first
  // agent decides it disagrees. A sender on no team is under no hierarchy
  // and keeps the behaviour it had before teams existed.
  if (kind === "task" && from.role !== undefined && !isLeadAddress(from.role)) {
    return "not-yours-to-assign";
  }
  return null;
}
