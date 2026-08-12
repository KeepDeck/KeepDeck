import { describe, expect, it } from "vitest";
import { MAIL_LIMITS, type Mail, type MailSender } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createMailManager } from "./mailManager";

const A: MailSender = { paneId: "pane-1", workspaceId: "ws-1", label: "Agent 1" };
const B: MailSender = { paneId: "pane-2", workspaceId: "ws-1", label: "Agent 2" };
/** A third pane, for the cases that are about a PAIR rather than about two
 * panes — one teammate's ask must not close another's. */
const C: MailSender = { paneId: "pane-3", workspaceId: "ws-1", label: "Agent 3" };

const done: PaneActivity = { state: "done", at: 1, interrupted: false };
const approving: PaneActivity = { state: "waiting", since: 1, reason: "permission" };

/** Longer than any spacing the manager applies, so a test that just wants
 * the next message to land does not have to know the gap. */
const PAST_SPACING = 5_000;

/** `Array.prototype.at` is outside this project's target lib. */
function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/** The edge on the message with this body among what was PASTED into panes.
 * Named rather than positional, and loud when the message never landed. */
function edgeOn(
  h: { delivered: readonly Mail[] },
  body: string,
): string | undefined {
  const sent = h.delivered.filter((mail) => mail.body === body);
  expect(sent, `expected exactly one delivered message saying "${body}"`).toHaveLength(1);
  return sent[0]?.replyTo;
}

function harness(options: { asksAtTurnEnd?: boolean } = {}) {
  let clock = 1_000;
  let deliverable = true;
  const activity = new Map<string, PaneActivity>();
  const listeners = new Set<() => void>();
  const channelWatchers = new Set<() => void>();
  const delivered: Mail[] = [];
  /** Panes nudged into a turn, in order. A wake carries nothing, so this is
   * the only trace of one. */
  const woken: string[] = [];
  let timer: { at: number; fn: () => void } | null = null;

  const manager = createMailManager({
    activityOf: (paneId) => activity.get(paneId),
    subscribeActivity: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeChannels: (listener) => {
      channelWatchers.add(listener);
      return () => channelWatchers.delete(listener);
    },
    deliver: (mail) => {
      if (!deliverable) return false;
      delivered.push(mail);
      return true;
    },
    wake: (paneId) => {
      if (!deliverable) return false;
      woken.push(paneId);
      return true;
    },
    asksAtTurnEnd: () => options.asksAtTurnEnd === true,
    now: () => clock,
    schedule: (fn, ms) => {
      timer = { at: clock + ms, fn };
      return () => {
        timer = null;
      };
    },
  });

  return {
    manager,
    delivered,
    woken,
    /** Set a pane's activity and tell the manager, as the tracker would. */
    reports(paneId: string, next: PaneActivity) {
      activity.set(paneId, next);
      for (const listener of [...listeners]) listener();
    },
    noChannel() {
      deliverable = false;
    },
    /** The terminal mounts: the registry says so, and NOTHING else does —
     * no status is emitted for it. */
    channelBack() {
      deliverable = true;
      for (const listener of [...channelWatchers]) listener();
    },
    /** How long the armed timer still has, or null when the last pass armed
     * none. A pass that schedules nothing is a real answer: some holds wait
     * on a subscription and have no later moment to wake for. */
    pending: () => (timer ? timer.at - clock : null),
    advance(ms: number) {
      clock += ms;
      // Fire whatever came due, letting each firing re-arm.
      for (let guard = 0; timer && timer.at <= clock && guard < 100; guard += 1) {
        const due = timer;
        timer = null;
        due.fn();
      }
    },
  };
}

describe("createMailManager", () => {
  it("places a message straight into a pane that can take it", () => {
    const h = harness();
    h.reports(B.paneId, done);
    const result = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "task",
      body: "rebase onto main",
    });
    expect(result).toEqual({ ok: true, id: "mail-1", delivered: true });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].body).toBe("rebase onto main");
    expect(h.delivered[0].from).toEqual({ kind: "pane", pane: A });
  });

  it("holds at a permission prompt and lands the moment the pane leaves it", () => {
    const h = harness();
    h.reports(B.paneId, approving);
    const result = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "note",
      body: "careful with that one",
    });
    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(h.delivered).toHaveLength(0);
    // The activity subscription is the whole retry mechanism: without it a
    // held message would wait for the expiry timer and then be dropped.
    h.reports(B.paneId, done);
    expect(h.delivered).toHaveLength(1);
  });

  it("spaces consecutive messages instead of merging them into one prompt", () => {
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "first" });
    const second = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "note",
      body: "second",
    });
    // Both are accepted, but only one has landed — two pastes back to back
    // reach the agent as a single garbled prompt.
    expect(second).toMatchObject({ ok: true, delivered: false });
    expect(h.delivered.map((mail) => mail.body)).toEqual(["first"]);
    h.advance(PAST_SPACING);
    expect(h.delivered.map((mail) => mail.body)).toEqual(["first", "second"]);
  });

  it("expires a message nobody could take, and tells its sender", () => {
    const h = harness();
    h.reports(A.paneId, done);
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    expect(h.delivered).toHaveLength(0);

    h.advance(MAIL_LIMITS.undeliveredMs);
    // The question never reached B; A hears about it instead of waiting on
    // an answer that can no longer come.
    expect(h.delivered).toHaveLength(1);
    const notice = h.delivered[0];
    expect(notice.kind).toBe("undelivered");
    expect(notice.from).toEqual({ kind: "host" });
    expect(notice.toPaneId).toBe(A.paneId);
    expect(notice.replyTo).toBe("mail-1");
  });

  it("does not report on a report — an expired notice ends the chain", () => {
    const h = harness();
    // Neither pane can take anything, so the notice expires too.
    h.reports(A.paneId, approving);
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });

    h.advance(MAIL_LIMITS.undeliveredMs);
    h.advance(MAIL_LIMITS.undeliveredMs);
    h.advance(MAIL_LIMITS.undeliveredMs);
    // Nothing was ever delivered, and crucially nothing is still pending:
    // a notice that minted another notice would keep the queue alive
    // forever, and the hop counter could not stop it — a notice copies its
    // hop rather than advancing it.
    expect(h.delivered).toHaveLength(0);
    h.reports(A.paneId, done);
    h.reports(B.paneId, done);
    expect(h.delivered).toHaveLength(0);
  });

  it("stops an A↔B ping-pong rather than letting two agents bill each other forever", () => {
    const h = harness();
    h.reports(A.paneId, done);
    h.reports(B.paneId, done);

    let from = A;
    let to = B;
    const results = [];
    for (let round = 0; round < MAIL_LIMITS.maxHops + 5; round += 1) {
      const result = h.manager.send({
        from,
        toPaneId: to.paneId,
        kind: "question",
        body: `round ${round}`,
      });
      results.push(result);
      if (!result.ok) break;
      h.advance(PAST_SPACING);
      [from, to] = [to, from];
    }

    // Each delivery moves the receiver one hop deeper, so the exchange runs
    // exactly as far as the budget allows and then refuses — on its own,
    // with nobody watching.
    expect(results.filter((result) => result.ok)).toHaveLength(MAIL_LIMITS.maxHops + 1);
    expect(last(results)).toEqual({ ok: false, refusal: "hop-limit" });
  });

  it("lets an untouched pane open a fresh chain after another one was spent", () => {
    const h = harness();
    h.reports(A.paneId, done);
    h.reports(B.paneId, done);
    // B is deep in a chain...
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "one" });
    h.advance(PAST_SPACING);
    // ...but A was never woken by mail, so what A sends still starts at zero.
    const fresh = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "two" });
    expect(fresh).toMatchObject({ ok: true });
    h.advance(PAST_SPACING);
    expect(last(h.delivered)?.hop).toBe(0);
  });

  it("delivers to a pane that has never reported anything at all", () => {
    // The live failure this exists for: a status reporter speaks on turn
    // events, so an idle pane reports NOTHING, and a task to a teammate
    // sitting at its prompt is exactly the message that must land.
    const h = harness();
    const result = h.manager.send({
      from: A,
      toPaneId: "pane-silent",
      kind: "task",
      body: "review the parser",
    });
    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(h.delivered).toHaveLength(1);
  });

  it("waits for the terminal to MOUNT, which no status ever announces", () => {
    // A pane can be alive and silent, so the channel's refusal is the only
    // thing that says "not writable yet" — and its recovery is the
    // registry, not an activity edge that may never come.
    const h = harness();
    h.noChannel();
    const result = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "go" });
    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(h.delivered).toHaveLength(0);
    // No status is reported here on purpose — the mount alone must do it.
    h.channelBack();
    expect(h.delivered).toHaveLength(1);
  });

  it("gives what has not been read, and nothing twice", () => {
    // No cursor: the agent used to carry one and carried the wrong one — its
    // own outgoing ids are never in its inbox, and an id this pane never
    // held replayed the whole journal as if it were new.
    const h = harness();
    h.reports(B.paneId, done);
    for (const body of ["one", "two", "three"]) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body });
      h.advance(PAST_SPACING);
    }
    expect(h.manager.inbox(B.paneId).messages.map((mail) => mail.body)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(h.manager.inbox(B.paneId).messages).toEqual([]);
    // Unless the caller asks for the journal, which is what an agent whose
    // context was rebuilt under it needs.
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toHaveLength(3);
  });

  it("reaches into the queue, which a cursor over the journal never could", () => {
    // Held for a turn boundary that has not come. Asking is itself the
    // labelled channel, so there is nothing to wait for.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "rebase onto main" });
    expect(h.delivered).toHaveLength(0);
    expect(h.manager.inbox(B.paneId).messages.map((mail) => mail.body)).toEqual([
      "rebase onto main",
    ]);
  });

  it("says how much did not fit, so a capped read is not mistaken for all of it", () => {
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    const long = "x".repeat(MAIL_LIMITS.handoverChars);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: long });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "and this one" });
    const first = h.manager.inbox(B.paneId);
    expect(first.messages).toHaveLength(1);
    expect(first.waiting).toBe(1);
    const rest = h.manager.inbox(B.paneId);
    expect(rest.messages.map((mail) => mail.body)).toEqual(["and this one"]);
    expect(rest.waiting).toBe(0);
  });

  it("gives a restarted process back what it can no longer remember reading", () => {
    // The mail is addressed to the pane and survives, but the process that
    // read it is gone and its context with it — so the agent starting now
    // catches up instead of silently missing what it was told.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "rebase onto main" });
    expect(h.manager.inbox(B.paneId).messages).toHaveLength(1);
    expect(h.manager.inbox(B.paneId).messages).toEqual([]);
    h.manager.clear(B.paneId);
    expect(h.manager.inbox(B.paneId).messages.map((mail) => mail.body)).toEqual([
      "rebase onto main",
    ]);
  });

  it("forgets panes that are gone", () => {
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "one" });
    expect(h.manager.inbox(B.paneId).messages).toHaveLength(1);
    h.manager.retain(new Set([A.paneId]));
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toEqual([]);
  });

  it("resets a restarted pane's place in a chain but keeps its mail", () => {
    const h = harness();
    h.reports(A.paneId, done);
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "one" });
    h.advance(PAST_SPACING);
    // Taking delivery put B one hop deep, so its reply continues the chain.
    // Asserting this BEFORE the clear is what makes the assertion after it
    // mean anything: without it, "hop 0" is also what a manager that never
    // counted hops at all would answer.
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "mid-chain" });
    h.advance(PAST_SPACING);
    expect(last(h.delivered)?.hop).toBe(1);

    h.manager.clear(B.paneId);
    const afterRestart = h.manager.send({
      from: B,
      toPaneId: A.paneId,
      kind: "answer",
      body: "done",
    });
    expect(afterRestart).toMatchObject({ ok: true });
    h.advance(PAST_SPACING);
    // A retired process took the chain with it: the new one is not mid-
    // conversation, so its first message opens a chain of its own.
    expect(last(h.delivered)?.hop).toBe(0);
    // What was already handed to the pane is addressed to the PANE, and
    // survives its process.
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toHaveLength(1);
  });

  it("refuses a pane mailing itself before anything is queued", () => {
    const h = harness();
    h.reports(A.paneId, done);
    expect(
      h.manager.send({ from: A, toPaneId: A.paneId, kind: "note", body: "hi me" }),
    ).toEqual({ ok: false, refusal: "self-addressed" });
    expect(h.delivered).toHaveLength(0);
    expect(h.manager.inbox(A.paneId, { all: true }).messages).toEqual([]);
  });

  it("waits out a running turn when the agent will come asking", async () => {
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    const result = h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    expect(result).toMatchObject({ ok: true, delivered: false });
    // Not pasted into a running turn: the labelled channel is coming.
    expect(h.delivered).toHaveLength(0);
    const taken = h.manager.takeAtTurnEnd(B.paneId);
    expect(taken.map((mail) => mail.body)).toEqual(["careful"]);
    // Handed over exactly once — booking is what stops a second channel
    // delivering the same message again.
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toHaveLength(1);
  });

  it("hands over one turn's worth at a time, leaving the rest queued", () => {
    // The receiver pays for every character in its next turn, and the SENDER
    // chooses how many there are. Nothing caps the queue, and a hand-over
    // used to drain all of it — so a teammate sending in a loop landed as one
    // enormous injection. Bounded HERE rather than in the framing, because
    // only the queue's owner can stop before a message without losing it:
    // by the time anything is framed it has already left the queue.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    // Two of these fit inside the budget; the short third one tips it over.
    const big = "x".repeat(MAIL_LIMITS.handoverChars / 2 - 1);
    for (const body of [big, big, "and a short one"]) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body });
    }

    // Two fit; the third waits, in order, for the next boundary.
    expect(h.manager.takeAtTurnEnd(B.paneId)).toHaveLength(2);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "and a short one",
    ]);
  });

  it("always carries at least one message, however long", () => {
    // A ceiling, not a target. A single message past the budget must still
    // go, or it would sit at the head of the queue forever and everything
    // behind it with it.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "note",
      body: "x".repeat(MAIL_LIMITS.handoverChars * 3),
    });
    expect(h.manager.takeAtTurnEnd(B.paneId)).toHaveLength(1);
  });

  it("nudges an idle pane AT ONCE, without waiting out a boundary that is not coming", () => {
    // The delay the whole feature felt like: measured live, a lead's three
    // answers each sat the full 45s wait because it had stopped 11 seconds
    // earlier. Nothing was going to bring a turn boundary, so every second
    // of that wait bought nothing.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "answer", body: "done" });
    expect(h.woken).toEqual([B.paneId]);
    expect(h.delivered).toEqual([]);
  });

  it("nudges the pane when a RUNNING turn outlasts the wait, and hands the message to nobody", () => {
    // The terminal's whole remaining job for an agent that can receive mail
    // properly. Pushing the message itself is what left a teammate's task
    // sitting unsent in a composer, indistinguishable from a delivery; a
    // nudge that fails loses a keystroke and the message is still queued.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    h.advance(MAIL_LIMITS.hookWaitMs);
    expect(h.woken).toEqual([B.paneId]);
    // NOTHING was handed over, and the message is still there for the turn
    // the nudge is about to start.
    expect(h.delivered).toEqual([]);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "careful",
    ]);
  });

  it("nudges a pane once per wait, however often it is asked to", () => {
    // A wake changes nothing about the queue, so nothing but the clock stops
    // the next pass repeating it — and a pane whose hook never answers would
    // be prodded on every drain until its mail expired.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    // An idle pane is nudged AT ONCE — nothing was going to bring a turn
    // boundary, so there was nothing to wait for.
    expect(h.woken).toEqual([B.paneId]);
    h.reports(B.paneId, { state: "working", since: 2 });
    h.reports(B.paneId, done);
    expect(h.woken).toEqual([B.paneId]);
    // ...and it IS worth repeating once that long has gone by with nothing
    // collected: the first nudge evidently produced no turn.
    h.advance(MAIL_LIMITS.hookWaitMs);
    expect(h.woken).toEqual([B.paneId, B.paneId]);
  });

  it("keeps a permission prompt held even when asked at a turn boundary", () => {
    // The prompt is about the TERMINAL. Arriving through a hook does not
    // make it safe to answer one.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);
    expect(h.delivered).toHaveLength(0);
  });

  it("reports an expired message to its sender even on the asking path", () => {
    const h = harness({ asksAtTurnEnd: true });
    h.reports(A.paneId, done);
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(MAIL_LIMITS.undeliveredMs);
    // It aged out along the way; the hand-over yields nothing and the
    // sender still hears about it. The report waits for A's own hook first,
    // like everything else, and reaches the terminal once that wait is up.
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);
    expect(h.manager.takeAtTurnEnd(A.paneId).map((mail) => mail.kind)).toEqual([
      "undelivered",
    ]);
  });

  it("lets the deck speak for itself, without spending a chain", () => {
    // The host already speaks for delivery reports; a team briefing is the
    // other thing only the deck knows. It starts no conversation, so it
    // must not cost the pane a hop from its budget.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    const [briefing] = h.manager.takeAtTurnEnd(B.paneId);
    expect(briefing.from).toEqual({ kind: "host" });
    expect(briefing.kind).toBe("team");
    expect(briefing.hop).toBe(0);
  });

  it("never types a briefing into a pane, however ready that pane is", () => {
    // A briefing states where a pane STANDS; it is context, not a summons.
    // Pasted, it lands in the composer looking like the person typed it —
    // which is the one reading that contradicts its own content. Observed
    // live: a freshly started teammate sat with its briefing unsent in the
    // input box. So it waits for the labelled channel however writable the
    // pane is, and comes out only through the hand-over.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    h.advance(PAST_SPACING);
    expect(h.delivered).toHaveLength(0);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
    ]);
  });

  it("arms no timer for a briefing held at a permission prompt", () => {
    // Found by review, and it was a live spin. A briefing never expires, so
    // "the moment it stops being worth delivering" — the deadline every other
    // hold schedules — is permanently in the past once `undeliveredMs` has
    // elapsed. A past deadline re-arms at the scheduler's 1ms floor, and the
    // next pass computes the same one: a 1ms loop for as long as the person
    // leaves the prompt unanswered.
    //
    // A permission prompt resolves through the activity subscription, and a
    // briefing has no clock of its own, so the honest answer is to schedule
    // nothing at all.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, approving);
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    h.advance(MAIL_LIMITS.undeliveredMs + 1);
    expect(h.pending()).toBeNull();
    // And it is still there, waiting for the prompt to clear.
    expect(h.manager.takeAtTurnEnd(B.paneId)).toHaveLength(0);
    h.reports(B.paneId, done);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
    ]);
  });

  it("drops a put-back briefing when a newer one is already waiting", () => {
    // The window is ordinary: a briefing is handed to the hook, the pane
    // restarts without reading it, the session-start announce puts the
    // CURRENT roster in the empty queue, and only then does the transport
    // report the old answer unread. `restore` unshifted raw, so the stale
    // briefing went to the FRONT — and standing context never expires, so
    // the agent read a superseded team first and, if its role changed across
    // that restart, acted on it.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    const [old] = h.manager.takeAtTurnEnd(B.paneId);
    expect(old.body).toContain("impl-1");

    h.manager.announce(B.paneId, "team", "you are lead on api");
    h.manager.restore([old]);

    // Only the current one, and it is the one that survives.
    const waiting = h.manager.takeAtTurnEnd(B.paneId);
    expect(waiting.map((mail) => mail.body)).toEqual(["you are lead on api"]);
  });

  it("keeps the newest briefing whichever way round the put-backs arrive", () => {
    // The transport arms one watchdog per reply FILE, so several put-backs
    // arrive in the order they were written — oldest first. A rule that asked
    // only "is one already waiting?" therefore dropped the ARRIVING message
    // every time, leaving the pane holding the stale briefing: worse than the
    // raw unshift it replaced. Only the newest statement is true, and which
    // one that is comes from its time, not its position.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    const [older] = h.manager.takeAtTurnEnd(B.paneId);
    h.advance(1_000);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    const [newer] = h.manager.takeAtTurnEnd(B.paneId);

    // Reported in write order: the older reply file times out first.
    h.manager.restore([older]);
    h.manager.restore([newer]);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "you are lead on api",
    ]);
  });

  it("still puts traffic back at the head, where it was", () => {
    // The supersede rule is about STANDING context only. A task or a note is
    // not made wrong by a later one, and losing it would be losing mail —
    // the very thing the put-back path exists to prevent.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "first" });
    const [taken] = h.manager.takeAtTurnEnd(B.paneId);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "second" });
    h.manager.restore([taken]);

    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "first",
      "second",
    ]);
  });

  it("lets a task past a briefing that is still waiting for its channel", () => {
    // Head-of-line blocking, seen live: a lead's pings to two teammates both
    // came back `delivered: false`, sitting behind briefings restated at
    // session start that nothing had collected. A briefing waits for a
    // DIFFERENT channel — that is a fact about the message, not about the
    // pane — so it must not stand in front of what the terminal can carry.
    // On an agent with NO labelled channel, which is where the hazard now
    // lives: a briefing there waits forever, because there is no later
    // moment at which typing it in becomes acceptable.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "task",
      body: "take the parser",
    });
    expect(h.delivered.map((mail) => mail.kind)).toEqual(["task"]);
    // And the briefing kept its place rather than being consumed with it.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
    ]);
  });

  it("leaves a briefing it stepped over exactly where it was", () => {
    // Stepping over one must neither deliver it nor lose it. It keeps no
    // clock, so the walk schedules nothing for it — and it is still there
    // for whatever turn eventually happens, however long that takes.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "take it" });
    expect(h.delivered.map((mail) => mail.kind)).toEqual(["task"]);
    h.advance(MAIL_LIMITS.undeliveredMs * 12);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
    ]);
  });

  it("keeps a briefing waiting however long the pane takes to speak", () => {
    // An agent with no session until somebody writes to it — kimi — takes no
    // turn of its own at all. On a clock its briefing would be gone by the
    // time a teammate's first task woke it, and it would be handed work with
    // no idea who was asking. A briefing cannot go stale, so it does not
    // keep a clock: it is still there for whatever turn finally happens.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    h.advance(MAIL_LIMITS.undeliveredMs * 12);
    expect(h.delivered).toHaveLength(0);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
    ]);
  });

  it("replaces a waiting briefing instead of stacking another on top", () => {
    // The deck re-states one on every fresh session and every rebuilt
    // context, and a briefing now waits indefinitely. Left to accumulate, a
    // pane that sat quiet through three restarts would be handed three at
    // once, two of them describing a team it has already been told about.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    const taken = h.manager.takeAtTurnEnd(B.paneId);
    expect(taken.map((mail) => mail.body)).toEqual(["you are impl-1 on api"]);
  });

  it("does not let a briefing displace a teammate's message", () => {
    // Superseding is about a kind replacing ITSELF. A task waiting beside it
    // is somebody's actual work and belongs to a different conversation.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "take it" });
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    h.manager.announce(B.paneId, "team", "you are impl-2 on api");
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "take it",
      "you are impl-2 on api",
    ]);
  });

  it("holds a task at a permission prompt, and lands it once that clears", () => {
    // The one dangerous state stays dangerous for the kinds that DO use the
    // terminal: keystrokes at a permission prompt pick menu items.
    const h = harness();
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "take the parser" });
    expect(h.delivered).toHaveLength(0);
    h.reports(B.paneId, done);
    expect(h.delivered).toHaveLength(1);
  });

  it("writes into no pane once disposed, even when still called", () => {
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.dispose();
    // Unsubscribing covers the activity path and cancelling covers the
    // timer, but `send` is a third way in and answers to neither — a caller
    // holding a stale reference would otherwise write into a pane belonging
    // to a runtime that is gone.
    const result = h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "one" });
    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(h.delivered).toHaveLength(0);
  });
});

describe("the reply edge", () => {
  /** Every pane here has a labelled channel, which is the ordinary case: mail
   * waits in the queue and its agent's hook collects it at a turn boundary. */
  function asking() {
    return harness({ asksAtTurnEnd: true });
  }

  /** A asks B something. Bodies differ so an assertion can name one. */
  function ask(h: ReturnType<typeof harness>, body: string) {
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body });
  }

  /** The pane takes a turn: its hook asks the deck what is waiting, and what
   * comes back lands in its context — which is what makes it READ. */
  function collect(h: ReturnType<typeof harness>, pane: MailSender) {
    return h.manager.takeAtTurnEnd(pane.paneId);
  }

  /**
   * The edge on the message carrying this body, collected at that pane's
   * boundary — found by lookup, never by position.
   *
   * Reading whatever landed most recently asserts about a message the test
   * never names: a delivery to a third pane, or one the deck itself sent, can
   * land in between. Failing loudly when the message is not there at all is
   * the other half — an edge read off `undefined` is a test that cannot fail.
   */
  function edgeAt(
    h: ReturnType<typeof harness>,
    pane: MailSender,
    body: string,
  ): string | undefined {
    const found = collect(h, pane).filter((mail) => mail.body === body);
    expect(found, `expected exactly one message saying "${body}"`).toHaveLength(1);
    return found[0]?.replyTo;
  }

  it("names what an answer answers", () => {
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeAt(h, A, "8080")).toBe("mail-1");
  });

  it("spends it, so the next thing said is not a second answer to it", () => {
    // The edge used to be computed per send and never consumed, so
    // everything a pane said to one teammate in a row carried the same
    // `replyTo` — one question with three answers, and an aside labelled as
    // one of them.
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "and 5432 for the db" });
    const [first, second] = collect(h, A);
    expect(first.replyTo).toBe("mail-1");
    expect(second.replyTo).toBeUndefined();
  });

  it("lets a task pass without answering anything or spending what is owed", () => {
    // A lead holding a teammate's question hands out the next piece of work
    // before getting to it. That work order is not a reply — and it must not
    // cost the lead the chance to reply afterwards.
    const h = asking();
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "question", body: "which port?" });
    collect(h, A);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "start on the parser" });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "answer", body: "8080" });
    const [task, answer] = collect(h, B);
    expect(task.replyTo).toBeUndefined();
    expect(answer.replyTo).toBe("mail-1");
  });

  it("is not answering a note, which nobody was waiting on", () => {
    // Booking every kind was the defect: an unbidden note became a debt that
    // the reader's next message spent, and an unrelated answer shipped
    // labelled as a reply to it. ONE note on purpose — two would leave the
    // pair ambiguous, and the test would pass without proving the note was
    // never a debt at all.
    const h = asking();
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "CI is red on main" });
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "starting on it" });
    expect(edgeAt(h, A, "starting on it")).toBeUndefined();
  });

  it("does not call a question a response, however much it reads like one", () => {
    // A question back at an ambiguous task and a question opening a new
    // subject are the same message to the deck. Treating both as responses
    // made the new subject spend the debt and arrive labelled as a reply.
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "question", body: "which env do you mean?" });
    expect(edgeAt(h, A, "which env do you mean?")).toBeUndefined();
  });

  it("refuses to choose between two the same teammate is waiting on, then recovers", () => {
    // Naming one would mark the other unanswered forever and this one
    // answered when it was not. Marking both anyway is what stops the two
    // from making every later exchange between them unattributable.
    const h = asking();
    ask(h, "which port?");
    ask(h, "and the host?");
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "both are in the env" });
    const [muddled] = collect(h, A);
    expect(muddled.replyTo).toBeUndefined();
    ask(h, "which env?");
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: ".env.local" });
    expect(edgeAt(h, A, ".env.local")).toBe("mail-4");
  });

  it("is unmoved by a permission prompt in the middle of the answering turn", () => {
    // An earlier mechanism read "not working" as the turn ending, so the
    // first approval prompt threw the question away and the answer that
    // followed named nothing — which is most real task turns.
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.reports(B.paneId, { state: "working", since: 2 });
    h.reports(B.paneId, approving);
    h.reports(B.paneId, { state: "working", since: 3 });
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeAt(h, A, "8080")).toBe("mail-1");
  });

  it("keeps the pairs apart when one pane owes two teammates at once", () => {
    // Two teammates, two debts, one pane. Nothing here is a pair of panes:
    // an answer to one must not close what the other is waiting on, and
    // must not read as ambiguous because two asks are outstanding in total.
    const h = asking();
    h.manager.send({ from: A, toPaneId: C.paneId, kind: "question", body: "which port?" });
    h.manager.send({ from: B, toPaneId: C.paneId, kind: "question", body: "which branch?" });
    collect(h, C);
    h.manager.send({ from: C, toPaneId: A.paneId, kind: "answer", body: "8080" });
    h.manager.send({ from: C, toPaneId: B.paneId, kind: "answer", body: "feat/parser" });
    expect(edgeAt(h, A, "8080")).toBe("mail-1");
    expect(edgeAt(h, B, "feat/parser")).toBe("mail-2");
  });

  it("does not let the deck's own voice stand in the way", () => {
    // A briefing or a delivery report between the question and the answer
    // must not make the pair look ambiguous — nobody is waiting on KeepDeck,
    // and an agent cannot answer it.
    const h = asking();
    ask(h, "which port?");
    h.manager.announce(B.paneId, "note", "a teammate left the team");
    collect(h, B);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeAt(h, A, "8080")).toBe("mail-1");
  });

  it("stops owing an answer to a handover that was put back unread", () => {
    const h = asking();
    ask(h, "which port?");
    const taken = h.manager.takeAtTurnEnd(B.paneId);
    expect(taken).toHaveLength(1);
    h.manager.restore(taken);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeAt(h, A, "8080")).toBeUndefined();
  });

  it("does not hand a restarted process an answer its predecessor was asked for", () => {
    // The mail survives the restart — it is addressed to the pane — but the
    // process that READ it is gone, so the agent starting now has not read
    // anything and is not answering it.
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.manager.clear(B.paneId);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeAt(h, A, "8080")).toBeUndefined();
  });

  it("forgets a pane that is gone for good", () => {
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.manager.retain(new Set([A.paneId]));
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toEqual([]);
  });
});

describe("what counts as reading", () => {
  it("does not treat a paste nobody asked for as read", () => {
    // A pane with no labelled channel is pasted into, and a paste is
    // answered by nothing at all: mid-turn it sits in an input buffer the
    // agent will not look at until the turn after next. Calling that read
    // would be the deck guessing.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.reports(A.paneId, done);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(h.delivered.map((mail) => mail.body)).toContain("which port?");
    expect(edgeOn(h, "8080")).toBeUndefined();
  });

  it("counts the agent going to look as reading", () => {
    // The same pasted message, once its agent asks for its mail. That ask is
    // the event the deck can witness, and it is what turns a delivery into
    // something the agent can be answering.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.inbox(B.paneId);
    h.reports(A.paneId, done);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });
});
