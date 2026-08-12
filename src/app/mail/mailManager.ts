/**
 * The owner of live mail state — one per app, outside React, the sibling of
 * `usageManager` and `agentStatusTracker`.
 *
 * Everything that DECIDES lives in `src/domain/mail`; this holds what the
 * decisions need and nothing else: a queue per receiver, what each pane has
 * been handed and whether it has read it, and where each pane sits in a
 * chain. Who owes whom an answer is NOT held — it is read off the journal,
 * because a second shape of the same facts is a second thing to keep in step
 * and they disagree exactly when it matters.
 *
 * It is where the MESSAGES live, and the only place they do. What sits
 * elsewhere is a hand-over in flight (`hookReply`'s memory of a batch given
 * to a transport that has not confirmed it), which is a fact about that
 * round trip rather than about the mail.
 *
 * A FACTORY, like both its siblings: the app's one instance lives in
 * `createAppRuntime` and reaches consumers as a value, while each test
 * builds a fresh one instead of resetting a shared module.
 *
 * Runtime-only, never persisted. A message describes an intent between two
 * LIVE processes; one restored next launch would be handed to an agent that
 * has no idea what it refers to, and its sender would be long gone.
 */
import {
  MAIL_LIMITS,
  awaitsAnswer,
  decideDelivery,
  decideHandover,
  decideSend,
  droppedNotice,
  isOverdue,
  isResponse,
  isStandingContext,
  overdueNotice,
  senderName,
  type Mail,
  type MailKind,
  type MailLimits,
  type MailSender,
  type SendRefusal,
} from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { log } from "../../ipc/log";

/**
 * The smallest gap between two deliveries into the SAME pane.
 *
 * Two blocks pasted back to back land in one input buffer and reach the
 * agent as a single garbled prompt. There is no delivery acknowledgement to
 * wait on — the deck cannot see the agent read anything — so spacing is the
 * only thing that keeps consecutive messages apart.
 */
const SERIALIZE_MS = 400;

/** How many delivered messages a pane keeps for catch-up reads. Bounded
 * because nothing prunes it otherwise and a long-lived pane would grow one
 * without limit. */
const INBOX_LIMIT = 50;

/** How many messages may WAIT for one pane. See [`enqueue`] for why a queue
 * needs a bound of its own now. */
const QUEUE_LIMIT = 50;

/**
 * One delivered message and where it stands with its receiver.
 *
 * The states are linear and each edge is an event the deck WITNESSES, never
 * one it infers:
 *
 * - `unread` — handed over, but nobody asked for it. A paste into a terminal
 *   is this: the text was pushed, and a pane mid-turn will not look at it
 *   until the turn after next. There is no acknowledgement on that channel,
 *   so calling it read would be a guess.
 * - `read` — the agent ASKED and got it: its hook collected at a turn
 *   boundary, or it called for its mail itself. Either way the words are in
 *   its context.
 * - `answered` — the pane has since sent an answer to that sender.
 *
 * This is what makes "who owes whom" a QUERY rather than a second store.
 * The ledger that used to hold it had to be kept in step with the inbox by
 * hand, and the answer it gave was the same answer this one derives.
 */
interface InboxEntry {
  mail: Mail;
  state: "unread" | "read" | "answered";
}

/**
 * One message, named the way a log line can carry it.
 *
 * Every outcome below is logged, and the reason is that mail has TWO channels
 * with no shared trace: a paste is visible in the pane and a hook answer is
 * visible nowhere. Which one carried a given message — or that neither did —
 * is otherwise unanswerable after the fact, and it is the first question any
 * report about mail not arriving has to settle. The body is never logged: it
 * is one agent's words to another, and the id is enough to follow it.
 */
function trace(mail: Mail): string {
  // `senderName` is the domain's own answer, so a log line and a delivered
  // message name a sender the same way. Spelled out here once, it drifted the
  // day the role started outranking the label — and a log that calls somebody
  // by a name the receiver never saw is worse than one that says nothing.
  return `${mail.id} ${mail.kind} ${senderName(mail) ?? "deck"} → ${mail.toPaneId}`;
}

export interface MailSendRequest {
  from: MailSender;
  toPaneId: string;
  kind: MailKind;
  body: string;
}

export type MailSendResult =
  /** Accepted. `delivered` says whether it landed SYNCHRONOUSLY — it is not
   * a read receipt, and a message delivered into a running turn is read
   * whenever that turn gets to it. */
  | { ok: true; id: string; delivered: boolean }
  | { ok: false; refusal: SendRefusal };

export interface MailManagerDeps {
  /** What this pane is doing right now, or undefined when nothing reports
   * for it. Read per call, never cached: activity moves under us. */
  activityOf(paneId: string): PaneActivity | undefined;
  /** Tell me when any pane's activity changed. A pane leaving a permission
   * prompt is precisely the event a held message waits for, and without
   * this the only thing that could notice would be the expiry timer. */
  subscribeActivity(listener: () => void): () => void;
  /** Tell me when a pane's input channel appears. A terminal mounting emits
   * no status, so this is the ONLY signal that a pane which reported
   * nothing has become writable — and a pane that reports nothing is
   * precisely the one waiting on this. */
  subscribeChannels(listener: () => void): () => void;
  /** Hand one message to its pane. False means the pane has no live input
   * channel at this instant — a retry, not a failure. */
  deliver(mail: Mail): boolean;
  /** Nudge a pane into taking a turn WITHOUT handing it anything. For an
   * agent that can receive mail properly: the turn fires the hook, and the
   * hook is what carries the words. Same false-means-retry contract. */
  wake(paneId: string): boolean;
  /** Whether this pane's agent asks the deck for its mail when a turn ends.
   * True means a running turn is worth waiting out — the answer given at
   * that boundary is labelled, and a paste is not. */
  asksAtTurnEnd?(paneId: string): boolean;
  now?(): number;
  /** `setTimeout`, injected so tests drive the clock. Returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
  limits?: MailLimits;
}

export interface MailManager {
  /** Accept a message, then try to place it immediately. */
  send(request: MailSendRequest): MailSendResult;
  /** Say something to a pane as the DECK, not as another agent.
   *
   * The host already speaks this way for delivery reports; this is the same
   * lane for the other thing only the deck knows — that a pane has joined a
   * team, or left one. It travels the ordinary route, so it waits out a
   * permission prompt and arrives labelled through the hook channel like
   * any other message.
   *
   * Hop zero: a fact stated by the deck starts no conversation and must not
   * spend the pane's chain budget on one.
   */
  announce(paneId: string, kind: MailKind, body: string): void;
  /** Hand over everything waiting for this pane, because its agent just
   * asked at a turn boundary — the moment the labelled channel is open.
   *
   * Takes them out of the queue and books them exactly as a delivery does,
   * so nothing can be handed over twice. Expired messages are dropped and
   * reported to their senders on the way, the same as any other pass, and
   * a message held for a permission prompt stays held: the prompt is about
   * the terminal, and the hook is not going to make it safe.
   */
  takeAtTurnEnd(paneId: string): Mail[];
  /** Put back messages taken at a turn boundary that could not be rendered
   * after all. They go to the FRONT, because they were the oldest waiting
   * and taking them must not cost them their place; their inbox entry is
   * withdrawn too, or a later read would show a message never delivered. */
  restore(messages: readonly Mail[]): void;
  /**
   * Everything this pane has not been given yet, oldest first — and asking
   * is what makes it READ.
   *
   * It reaches into the QUEUE as well as the journal, which the old
   * cursor-based read could not: a message held for a turn boundary that
   * never came, or one the boundary's budget cut short, was unreachable by
   * asking. An explicit ask is the labelled channel — the answer travels
   * back as this call's result and never through the terminal — so a
   * permission prompt is no reason to hold it back, though age still is.
   *
   * `all` re-reads the whole journal instead, for an agent whose context was
   * rebuilt under it. `waiting` says how much did not fit this time.
   *
   * There is no cursor. The agent used to carry one, and carried the wrong
   * one — its own outgoing ids are never in its inbox, and an id this pane
   * never held replayed the entire journal as if it were new.
   */
  inbox(paneId: string, options?: { all?: boolean }): { messages: Mail[]; waiting: number };
  /** How much this pane has not been given yet — queued, plus delivered but
   * never asked for. Read after a hand-over to tell the agent what its
   * turn's budget left behind. */
  waiting(paneId: string): number;
  /** Forget everything belonging to panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void;
  /** The pane's process was retired (restart, suspend). Its place in a chain
   * and its delivery spacing describe that process and mean nothing to the
   * next one; queued and delivered mail is addressed to the PANE and stays. */
  clear(paneId: string): void;
  dispose(): void;
}

function earlier(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function createMailManager(deps: MailManagerDeps): MailManager {
  const limits = deps.limits ?? MAIL_LIMITS;
  const asksAtTurnEnd = deps.asksAtTurnEnd ?? (() => false);
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  /** Pending mail per receiver, oldest first. A pane with an empty queue is
   * removed, so the map doubles as "who is waiting on something". */
  const queues = new Map<string, Mail[]>();
  /** Delivered mail per receiver, for catch-up reads and for working out who
   * owes whom an answer. */
  const inboxes = new Map<string, InboxEntry[]>();
  /** The hop of the message that last WOKE each pane — what the next message
   * that pane sends inherits. */
  const chainHop = new Map<string, number>();
  /** When each pane last took delivery, for spacing. */
  const lastDeliveryAt = new Map<string, number>();
  /** When each pane was last nudged into a turn.
   *
   * A wake hands nothing over, so nothing about the queue changes to stop
   * the next pass doing it again. This is what stops it: one nudge per pane
   * per wait window, which is also the interval after which a nudge that
   * produced no turn is worth repeating. Without it a pane whose hook never
   * answers would be prodded on every drain until its mail expired. */
  const lastWakeAt = new Map<string, number>();

  /** Queued messages whose sender has already been told they are waiting.
   * An id leaves when its message leaves the queue. */
  const reportedOverdue = new Set<string>();

  let sequence = 0;
  let cancelTimer: (() => void) | null = null;
  let disposed = false;

  function mintId(): string {
    sequence += 1;
    return `mail-${sequence}`;
  }

  function enqueue(mail: Mail): void {
    log.info("web:mail", `queued: ${trace(mail)}`);
    const queue = queues.get(mail.toPaneId);
    if (!queue) {
      queues.set(mail.toPaneId, [mail]);
      return;
    }
    // Standing context SUPERSEDES itself. It keeps no clock, so an
    // undelivered briefing waits for as long as the pane takes — and the
    // deck re-states one on every fresh session and every rebuilt context.
    // Left to accumulate, a pane that sat quiet through three restarts
    // would be handed three briefings at once, two of them describing a
    // team it has already been told about. Only the newest is true.
    if (isStandingContext(mail.kind)) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].kind === mail.kind) queue.splice(i, 1);
      }
    }
    queue.push(mail);
    // The only bound left on a queue, and it had to replace one: age used to
    // empty it, and age no longer drops anything. A pane that has collected
    // nothing for this long is not about to catch up on the oldest, so the
    // oldest is what goes — and its sender is told, because this is the one
    // remaining way a message is genuinely lost.
    while (queue.length > QUEUE_LIMIT) {
      const dropped = queue.shift();
      if (!dropped) break;
      leftQueue(dropped);
      log.warn("web:mail", `dropped, the queue is full: ${trace(dropped)}`);
      const notice = droppedNotice(dropped, mintId(), now());
      if (notice) enqueue(notice);
    }
  }

  /** Book a delivery, saying whether the receiver ASKED for it — see
   * [`InboxEntry`] for why that distinction is the whole model. */
  function remember(paneId: string, mail: Mail, state: InboxEntry["state"]): void {
    const held = inboxes.get(paneId) ?? [];
    held.push({ mail, state });
    if (held.length > INBOX_LIMIT) held.splice(0, held.length - INBOX_LIMIT);
    inboxes.set(paneId, held);
  }

  /**
   * What `paneId` has READ from `senderPaneId` and still owes an answer to.
   *
   * Read, because an answer can only be answering something its sender has
   * actually seen. Awaiting an answer, because a note informs and an answer
   * closes — neither is an open ask, and booking them made an unrelated
   * message arrive labelled as a reply to one.
   *
   * The deck's own voice never qualifies: a briefing or a delivery report
   * has no pane behind it and cannot be answered.
   */
  function owedTo(paneId: string, senderPaneId: string): InboxEntry[] {
    return (inboxes.get(paneId) ?? []).filter(
      (entry) =>
        entry.state === "read" &&
        awaitsAnswer(entry.mail.kind) &&
        entry.mail.from.kind === "pane" &&
        entry.mail.from.pane.paneId === senderPaneId,
    );
  }

  /**
   * What a message from `fromPaneId` to `toPaneId` is answering, marking
   * what it closes on the way out.
   *
   * Only an ANSWER closes anything, so a lead handing out the next task
   * while holding a teammate's question keeps its chance to answer it, and
   * that task is not labelled a reply to it.
   *
   * Two open asks yield no edge and are BOTH marked answered. Naming one
   * would mark the other unanswered forever and this one answered when it
   * was not; a wrong edge fails toward a missed observation ("nobody is
   * waiting on anything") while a missing one fails toward a visible one,
   * and the deck is watched, so it should err loudly. Marking them anyway is
   * what keeps a pair from being permanently unable to draw an edge again.
   */
  function takeReplyEdge(
    fromPaneId: string,
    toPaneId: string,
    kind: MailKind,
  ): string | undefined {
    if (!isResponse(kind)) return undefined;
    const owed = owedTo(fromPaneId, toPaneId);
    for (const entry of owed) entry.state = "answered";
    return owed.length === 1 ? owed[0].mail.id : undefined;
  }

  /**
   * Tell the senders of anything that has been queued too long, once each.
   *
   * Once, because the message is not going anywhere: it stays queued until
   * its pane can take it, so a report every window would be the same news
   * repeated at a sender that can do nothing with it. `reportedOverdue`
   * is what makes it once, and an id leaves that set when its message
   * leaves the queue.
   *
   * Walks every queued message rather than each queue's head. The walk that
   * delivers stops at the first thing it cannot place, so a message behind a
   * held one is exactly the message most likely to be waiting — and under
   * the old rule it was the one that quietly died there.
   *
   * Returns when the next unreported message comes due, so the drain can arm
   * a timer for it, or null when nothing is pending.
   */
  function reportOverdue(at: number): number | null {
    let due: number | null = null;
    for (const queue of [...queues.values()]) {
      for (const mail of [...queue]) {
        if (reportedOverdue.has(mail.id)) continue;
        if (!isOverdue(mail, at, limits)) {
          if (!isStandingContext(mail.kind)) {
            due = earlier(due, mail.at + limits.undeliveredMs);
          }
          continue;
        }
        reportedOverdue.add(mail.id);
        log.info("web:mail", `still queued after ${at - mail.at}ms: ${trace(mail)}`);
        const notice = overdueNotice(mail, mintId(), at);
        if (notice) enqueue(notice);
      }
    }
    return due;
  }

  /** A message has left a queue for good; it can no longer come due. */
  function leftQueue(mail: Mail): void {
    reportedOverdue.delete(mail.id);
  }

  /**
   * Walk one pane's queue as far as it will go, and report when this pane
   * next needs attention (null = nothing pending).
   *
   * At most ONE message is handed over per call: the next needs its spacing
   * gap, and the timer this returns is what comes back for it. Expiring
   * messages do not consume that budget — they never reached the pane.
   *
   * Two of the three holds are facts about the PANE — it is at a permission
   * prompt, its turn has not ended — and those stop the walk, because they
   * are just as true of everything behind them. The third is a fact about
   * the MESSAGE: one that may only arrive labelled is waiting for a
   * different channel entirely, and stopping there would let a briefing
   * nobody has collected stand in front of every task the terminal could
   * carry. Observed live: a lead's pings to two teammates both came back
   * `delivered: false`, queued behind briefings restated at session start.
   */
  function drainPane(paneId: string, queue: Mail[], at: number): number | null {
    /** The earliest deadline owed to messages this walk stepped OVER. They
     * are still queued and still expire, so their clock has to survive a
     * pass that found nothing deliverable behind them. */
    let skipped: number | null = null;
    let index = 0;
    while (index < queue.length) {
      const head = queue[index];
      const verdict = decideDelivery(
        head,
        deps.activityOf(paneId),
        at,
        limits,
        asksAtTurnEnd(paneId),
      );
      // The message's own restriction, not the pane's: step over it and keep
      // looking. It leaves through `takeAtTurnEnd` or not at all — and it
      // schedules NOTHING, because standing context keeps no clock. There is
      // no later moment at which this pass would decide differently about
      // it, so waking a timer for one would be waking it to do nothing.
      if (verdict.kind === "hold" && verdict.reason === "labelled-only") {
        log.debug("web:mail", `waiting for the labelled channel: ${trace(head)}`);
        index += 1;
        continue;
      }
      // Held for a turn boundary: the wait is bounded, so the deadline is
      // when waiting stops being worth it — not when the message dies.
      // Missing that distinction would leave a pane whose turn never ends
      // silently losing its mail instead of falling back to the terminal.
      if (verdict.kind === "hold" && verdict.reason === "turn-boundary") {
        log.debug("web:mail", `held for a turn boundary: ${trace(head)}`);
        // Only a message that will give up waiting needs a deadline. One
        // that expects an answer nudges once the wait runs out; routine mail
        // waits for the boundary however long it takes, and resolves through
        // the activity subscription like the permission hold below — so
        // arming a timer for it would wake the pass to decide nothing.
        return awaitsAnswer(head.kind)
          ? earlier(skipped, head.at + limits.hookWaitMs)
          : skipped;
      }
      // Held on a permission prompt, which resolves through the activity
      // subscription — so the only thing left to schedule is the moment this
      // message stops being worth delivering.
      //
      // Standing context has no such moment: it never expires, so its
      // "stops being worth delivering" instant is permanently in the past
      // once `undeliveredMs` elapses, and a deadline in the past re-arms the
      // timer at its 1ms floor — forever, for as long as the prompt is up. It
      // waits on the activity subscription like the rest, and schedules
      // nothing, exactly as the labelled-only branch above does.
      if (verdict.kind === "hold") {
        log.debug("web:mail", `held on ${verdict.reason}: ${trace(head)}`);
        return isStandingContext(head.kind)
          ? skipped
          : earlier(skipped, head.at + limits.undeliveredMs);
      }
      // A nudge, not a delivery: the message stays exactly where it is, and
      // what it buys is a TURN — whose hook then carries the words properly.
      // Nothing about the queue changes, so the only thing stopping the next
      // pass repeating it is the clock.
      if (verdict.kind === "wake") {
        const woken = lastWakeAt.get(paneId);
        // A nudge into a RUNNING turn is not lost — it is sitting in the
        // CLI's input queue and will fire a turn on its own. Repeating it
        // queues another, and another, and the pane pays for every one when
        // the current turn finally ends. The clock below is for the other
        // case, where a nudge that produced no turn plausibly went missing.
        if (deps.activityOf(paneId)?.state === "working" && woken !== undefined) {
          return skipped;
        }
        if (woken !== undefined && at - woken < limits.hookWaitMs) {
          return earlier(skipped, woken + limits.hookWaitMs);
        }
        if (!deps.wake(paneId)) {
          log.debug("web:mail", `no input channel to wake: ${trace(head)}`);
          return earlier(skipped, head.at + limits.undeliveredMs);
        }
        log.info("web:mail", `nudged the pane into a turn for: ${trace(head)}`);
        lastWakeAt.set(paneId, at);
        return earlier(skipped, at + limits.hookWaitMs);
      }
      const last = lastDeliveryAt.get(paneId);
      if (last !== undefined && at - last < SERIALIZE_MS) {
        return earlier(skipped, last + SERIALIZE_MS);
      }
      // No input channel: the pane is starting, or stopped. This is the ONE
      // refusal that says so — a pane can be perfectly alive and report no
      // activity at all — and it resolves through `subscribeChannels`, not
      // through activity, because a terminal mounting emits no status. The
      // deadline is only the backstop for a pane that never comes back.
      if (!deps.deliver(head)) {
        log.debug("web:mail", `no input channel yet: ${trace(head)}`);
        return earlier(skipped, head.at + limits.undeliveredMs);
      }
      log.info("web:mail", `pasted into the pane: ${trace(head)}`);
      queue.splice(index, 1);
      leftQueue(head);
      lastDeliveryAt.set(paneId, at);
      // The receiver now stands one message deep in this chain: whatever it
      // sends next continues from here, which is what bounds a conversation.
      chainHop.set(paneId, head.hop);
      // Pushed, not asked for: nothing answers a paste, and a pane mid-turn
      // will not look at it until the turn after next.
      remember(paneId, head, "unread");
      return earlier(skipped, queue.length > 0 ? at + SERIALIZE_MS : null);
    }
    return skipped;
  }

  function drain(): void {
    if (disposed) return;
    const at = now();
    // Before placing anything: a message that has waited too long earns its
    // sender a word, and the notice is itself deliverable mail that the pass
    // below should place in the same breath. It cannot cascade — a notice
    // about a notice is refused by `overdueNotice`.
    let deadline = reportOverdue(at);
    for (const [paneId, queue] of [...queues]) {
      deadline = earlier(deadline, drainPane(paneId, queue, at));
      if (queue.length === 0) queues.delete(paneId);
    }
    cancelTimer?.();
    cancelTimer = null;
    if (deadline === null) return;
    // Never below zero, and never zero: a deadline already past would spin
    // the timer against a clock that has not moved.
    cancelTimer = schedule(() => {
      cancelTimer = null;
      drain();
    }, Math.max(1, deadline - at));
  }

  const unsubscribes = [
    deps.subscribeActivity(() => drain()),
    deps.subscribeChannels(() => drain()),
  ];

  return {
    send(request) {
      const inherited = chainHop.get(request.from.paneId) ?? null;
      const verdict = decideSend(
        request.from,
        request.toPaneId,
        inherited,
        limits,
        request.kind,
      );
      if (verdict.kind === "refuse") return { ok: false, refusal: verdict.refusal };
      // Derived, never taken from the caller. An agent maintaining this by
      // hand cost two lines of briefing, was checked by nothing, and taught
      // it to hoard message ids — which then reached `inbox`'s `since` as an
      // id that pane never held.
      const replyTo = takeReplyEdge(request.from.paneId, request.toPaneId, request.kind);
      const mail: Mail = {
        id: mintId(),
        kind: request.kind,
        body: request.body,
        from: { kind: "pane", pane: request.from },
        toPaneId: request.toPaneId,
        at: now(),
        hop: verdict.hop,
        ...(replyTo ? { replyTo } : {}),
      };
      enqueue(mail);
      drain();
      // Still queued means it did not land. It cannot have expired — it was
      // minted at `now()` — so "gone from the queue" is exactly "delivered".
      const pending = queues.get(mail.toPaneId);
      const delivered = !pending?.some((queued) => queued.id === mail.id);
      return { ok: true, id: mail.id, delivered };
    },

    announce(paneId, kind, body) {
      enqueue({
        id: mintId(),
        kind,
        body,
        from: { kind: "host" },
        toPaneId: paneId,
        at: now(),
        hop: 0,
      });
      drain();
    },

    takeAtTurnEnd(paneId) {
      const queue = queues.get(paneId);
      if (!queue) return [];
      const taken: Mail[] = [];
      let carried = 0;
      while (queue.length > 0) {
        const head = queue[0];
        // Enough for this turn. The receiver pays for every character in its
        // next turn and the SENDER chooses how many there are, so a loop of
        // sends would otherwise arrive as one enormous injection. What is
        // left keeps its place at the head of the queue and goes at the next
        // boundary — nothing is dropped, because by here it has already left
        // the queue's protection.
        //
        // Checked AFTER at least one message is taken: a single message
        // longer than the whole budget must still be delivered, or it would
        // sit at the head forever and block everything behind it.
        if (taken.length > 0 && carried + head.body.length > limits.handoverChars) {
          log.info(
            "web:mail",
            `handing over ${taken.length} of ${taken.length + queue.length} — ${carried} chars is enough for one turn`,
          );
          break;
        }
        // The same two clauses the other channel obeys, asked rather than
        // repeated: a pane parked on a permission prompt is unsafe to push at
        // through either door. Copied here once, it made a fifth reason to
        // hold something the terminal would honour and this — the path a
        // briefing exclusively uses — would silently ignore.
        if (decideHandover(deps.activityOf(paneId)) === "hold") break;
        queue.shift();
        leftQueue(head);
        chainHop.set(paneId, head.hop);
        // The agent's own hook asked for this and is about to be handed it,
        // so it lands in context: read, by the only definition the deck can
        // witness.
        remember(paneId, head, "read");
        log.info("web:mail", `handed to the turn-end hook: ${trace(head)}`);
        taken.push(head);
        carried += head.body.length;
      }
      if (queue.length === 0) queues.delete(paneId);
      // Whatever is left (a held prompt, a fresh notice) still needs its
      // timer, and the queue just moved under it.
      drain();
      return taken;
    },

    restore(messages) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const mail = messages[i];
        log.info("web:mail", `put back, nobody took it: ${trace(mail)}`);
        const queue = queues.get(mail.toPaneId);
        if (!queue) {
          queues.set(mail.toPaneId, [mail]);
        } else if (isStandingContext(mail.kind)) {
          // Only the NEWEST statement of a standing context is true. The
          // window is ordinary: a briefing is handed over, the pane restarts
          // without reading it, the session-start announce puts the current
          // roster in the queue, and only then does the transport report the
          // old answer unread. Standing context never expires, so an agent
          // handed both would read a superseded team first — and if its role
          // changed across that restart, act on it.
          //
          // Compared by TIME, not by position. Nothing says the queued one is
          // the newer: the transport arms one watchdog per reply file, so
          // several put-backs arrive in the order they were WRITTEN, oldest
          // first. Asking "is one already waiting?" dropped the arriving
          // message every time and left the pane holding the stale briefing —
          // worse than the raw unshift it replaced.
          //
          // `enqueue` states the same rule for the arriving direction; there
          // it is trivially true, because what arrives is always newest.
          const newer = queue.some(
            (waiting) => waiting.kind === mail.kind && waiting.at >= mail.at,
          );
          if (newer) {
            log.info("web:mail", `dropped on the way back, superseded: ${trace(mail)}`);
          } else {
            for (let at = queue.length - 1; at >= 0; at -= 1) {
              if (queue[at].kind === mail.kind) queue.splice(at, 1);
            }
            queue.unshift(mail);
          }
        } else {
          queue.unshift(mail);
        }
        // Withdrawing the entry withdraws the ask with it — one of the
        // things a derived answer costs nothing to keep in step, where a
        // ledger beside the inbox needed its own line here.
        const held = inboxes.get(mail.toPaneId);
        const at = held?.findIndex((entry) => entry.mail.id === mail.id) ?? -1;
        if (held && at >= 0) held.splice(at, 1);
      }
      drain();
    },

    inbox(paneId, options) {
      // Empty the queue into the journal first, holding nothing back. The one
      // refusal a turn-boundary handover honours — a pane parked on a
      // permission prompt — is about pushing AT a pane, and this is the pane
      // asking. Age is no reason either: nothing is dropped for being late,
      // and a message that waited is exactly what an agent going to look for
      // its mail is looking for.
      const queue = queues.get(paneId) ?? [];
      while (queue.length > 0) {
        const head = queue[0];
        queue.shift();
        leftQueue(head);
        chainHop.set(paneId, head.hop);
        remember(paneId, head, "unread");
        log.info("web:mail", `handed to an explicit read: ${trace(head)}`);
      }
      if (queue.length === 0) queues.delete(paneId);

      const held = inboxes.get(paneId) ?? [];
      const pool = options?.all ? held : held.filter((entry) => entry.state === "unread");
      const messages: Mail[] = [];
      let carried = 0;
      for (const entry of pool) {
        // The same budget a turn boundary obeys, and for the same reason:
        // every character lands in this agent's context. Checked AFTER one
        // is taken, so a single message longer than the whole budget is
        // still readable instead of blocking everything behind it.
        if (messages.length > 0 && carried + entry.mail.body.length > limits.handoverChars) break;
        // Asking for it IS reading it — the one moment the deck can witness
        // rather than assume. An answered entry re-read stays answered:
        // it has been through this and re-reading does not reopen it.
        if (entry.state === "unread") entry.state = "read";
        messages.push(entry.mail);
        carried += entry.mail.body.length;
      }
      // A notice may have been queued by an expiry above, and the queue just
      // moved under whatever timer was armed for it.
      drain();
      return { messages, waiting: pool.length - messages.length };
    },

    waiting(paneId) {
      const queued = queues.get(paneId)?.length ?? 0;
      const unread = (inboxes.get(paneId) ?? []).filter(
        (entry) => entry.state === "unread",
      ).length;
      return queued + unread;
    },

    retain(liveIds) {
      for (const map of [queues, inboxes, chainHop, lastDeliveryAt, lastWakeAt]) {
        for (const id of [...map.keys()]) {
          if (!liveIds.has(id)) map.delete(id);
        }
      }
    },

    clear(paneId) {
      chainHop.delete(paneId);
      lastDeliveryAt.delete(paneId);
      // The process that read this pane's mail is gone, and its context with
      // it — so as far as the agent about to start is concerned, none of it
      // has been read. Saying so is what lets it catch up on its first ask
      // instead of silently missing what it was told. What it already
      // ANSWERED stays answered: that was a fact about the pane, not about
      // the process, and reopening it would invite a second answer.
      for (const entry of inboxes.get(paneId) ?? []) {
        if (entry.state === "read") entry.state = "unread";
      }
      // A nudge was aimed at the process that just retired. The next one
      // starts fresh and is owed one of its own — most of all here, since a
      // restarted pane is exactly the pane that has forgotten everything.
      lastWakeAt.delete(paneId);
    },

    dispose() {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
