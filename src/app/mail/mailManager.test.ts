import { describe, expect, it } from "vitest";
import { MAIL_LIMITS, type Mail, type MailSender } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createMailManager } from "./mailManager";

const A: MailSender = { paneId: "pane-1", workspaceId: "ws-1", label: "Agent 1" };
const B: MailSender = { paneId: "pane-2", workspaceId: "ws-1", label: "Agent 2" };

const done: PaneActivity = { state: "done", at: 1, interrupted: false };
const approving: PaneActivity = { state: "waiting", since: 1, reason: "permission" };

/** Longer than any spacing the manager applies, so a test that just wants
 * the next message to land does not have to know the gap. */
const PAST_SPACING = 5_000;

/** `Array.prototype.at` is outside this project's target lib. */
function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
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

  it("reads an inbox forward from a cursor, and from the start when it aged out", () => {
    const h = harness();
    h.reports(B.paneId, done);
    for (const body of ["one", "two", "three"]) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body });
      h.advance(PAST_SPACING);
    }
    const all = h.manager.inbox(B.paneId);
    expect(all.map((mail) => mail.body)).toEqual(["one", "two", "three"]);
    expect(h.manager.inbox(B.paneId, all[0].id).map((mail) => mail.body)).toEqual([
      "two",
      "three",
    ]);
    expect(h.manager.inbox(B.paneId, all[2].id)).toEqual([]);
    // An unknown cursor yields everything rather than nothing: a repeat is
    // recoverable, a silent hole is not.
    expect(h.manager.inbox(B.paneId, "mail-999")).toHaveLength(3);
  });

  it("forgets panes that are gone", () => {
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "one" });
    expect(h.manager.inbox(B.paneId)).toHaveLength(1);
    h.manager.retain(new Set([A.paneId]));
    expect(h.manager.inbox(B.paneId)).toEqual([]);
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
    expect(h.manager.inbox(B.paneId)).toHaveLength(1);
  });

  it("refuses a pane mailing itself before anything is queued", () => {
    const h = harness();
    h.reports(A.paneId, done);
    expect(
      h.manager.send({ from: A, toPaneId: A.paneId, kind: "note", body: "hi me" }),
    ).toEqual({ ok: false, refusal: "self-addressed" });
    expect(h.delivered).toHaveLength(0);
    expect(h.manager.inbox(A.paneId)).toEqual([]);
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
    expect(h.manager.inbox(B.paneId)).toHaveLength(1);
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
  /** The one edge everything else is a variation on: A asks, B answers. */
  function asked(h: ReturnType<typeof harness>) {
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.reports(A.paneId, done);
  }

  /**
   * The edge on the message carrying this body — found by lookup, never by
   * position.
   *
   * Reading the last delivery asserts about whatever landed most recently,
   * which is not always the message under test: a delivery to a third pane,
   * or one the deck itself sent, can land in between, and the assertion then
   * passes or fails for reasons the test never states. Failing loudly when
   * the message was not delivered at all is the other half — an edge read
   * off `undefined` is a test that cannot fail.
   */
  function edgeOn(h: ReturnType<typeof harness>, body: string): string | undefined {
    const sent = h.delivered.filter((mail) => mail.body === body);
    expect(sent, `expected exactly one delivered message saying "${body}"`).toHaveLength(1);
    return sent[0]?.replyTo;
  }

  it("names what an answer answers", () => {
    const h = harness();
    asked(h);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });

  it("spends it, so the next thing said is not a second answer to it", () => {
    // The edge used to be computed per send and never consumed, so
    // everything a pane said to one teammate in a row carried the same
    // `replyTo` — one question with three answers, and an aside labelled as
    // one of them.
    const h = harness();
    asked(h);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    h.advance(PAST_SPACING);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "question", body: "and the host?" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
    expect(edgeOn(h, "and the host?")).toBeUndefined();
  });

  it("lets a task pass without answering anything or spending what is owed", () => {
    // A lead holding a teammate's question hands out the next piece of work
    // before getting to it. That work order is not a reply — and it must not
    // cost the lead the chance to reply afterwards.
    const h = harness();
    h.reports(A.paneId, done);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "question", body: "which port?" });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "start on the parser" });
    h.advance(PAST_SPACING);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "start on the parser")).toBeUndefined();
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });

  it("refuses to choose between two the same teammate is waiting on, then recovers", () => {
    // Naming one would mark the other unanswered forever and this one
    // answered when it was not. Settling the pair anyway is what stops the
    // two from making every later exchange between them unattributable.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(PAST_SPACING);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "and the host?" });
    h.reports(A.paneId, done);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "both are in the env" });
    h.advance(PAST_SPACING);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which env?" });
    h.advance(PAST_SPACING);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: ".env.local" });
    expect(edgeOn(h, "both are in the env")).toBeUndefined();
    expect(edgeOn(h, ".env.local")).toBe("mail-4");
  });

  it("is unmoved by a permission prompt in the middle of the answering turn", () => {
    // The previous mechanism read "not working" as the turn ending, so the
    // first approval prompt threw the question away and the answer that
    // followed named nothing — which is most real task turns.
    const h = harness();
    asked(h);
    // B — the pane that owes the answer — works, stops for an approval, and
    // carries on. None of that ends its turn.
    h.reports(B.paneId, { state: "working", since: 2 });
    h.reports(B.paneId, approving);
    h.reports(B.paneId, { state: "working", since: 3 });
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });

  it("works for a pane that reports no activity at all", () => {
    // Nothing here is reported: a CLI with no status voice, or one whose
    // plugin contributes a renderer and no normalizer. The old mechanism
    // waited for a transition that never came, so such a pane accumulated
    // candidates for the whole session and answered with a stale edge.
    const h = harness();
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });

  it("does not let the deck's own voice stand in the way", () => {
    // A briefing or a delivery report arriving between the question and the
    // answer must not make the pair look ambiguous — nobody is waiting on
    // KeepDeck, and an agent cannot answer it.
    const h = harness();
    asked(h);
    // Handed to B, the pane that owes the answer, between the question and
    // its reply — the position where a second teammate message would make
    // the pair ambiguous.
    h.advance(PAST_SPACING);
    h.manager.announce(B.paneId, "note", "a teammate left the team");
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });

  it("stops owing an answer to a handover that was put back unread", () => {
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    const taken = h.manager.takeAtTurnEnd(B.paneId);
    expect(taken).toHaveLength(1);
    h.manager.restore(taken);
    h.reports(A.paneId, done);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    // Read through the boundary, not through `delivered`: a pane that asks
    // at a turn end is nudged rather than pasted into, so nothing lands in
    // the terminal and asserting there would pass without proving anything.
    const [answer] = h.manager.takeAtTurnEnd(A.paneId);
    expect(answer.replyTo).toBeUndefined();
  });

  it("does not hand a restarted process an answer its predecessor was asked for", () => {
    const h = harness();
    asked(h);
    // B's process retires — a restart, a suspend. Whatever it was asked, it
    // was asked of a process that no longer exists.
    h.manager.clear(B.paneId);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBeUndefined();
  });

  it("forgets what a pane that is gone was waiting for", () => {
    // Both halves of a pair have to go, or the survivor answers into a
    // conversation whoever inherits the slot was never part of.
    const h = harness();
    asked(h);
    h.manager.retain(new Set([B.paneId]));
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBeUndefined();
  });
});
