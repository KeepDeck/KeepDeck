import { describe, expect, it } from "vitest";
import { MAIL_LIMITS, type MailSender } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createMailManager } from "./mailManager";

const A: MailSender = { paneId: "pane-1", workspaceId: "ws-1", label: "Agent 1" };
const B: MailSender = { paneId: "pane-2", workspaceId: "ws-1", label: "Agent 2" };
/** A third pane, for the cases that are about a PAIR rather than about two
 * panes — one teammate's ask must not close another's. */
const C: MailSender = { paneId: "pane-3", workspaceId: "ws-1", label: "Agent 3" };

const done: PaneActivity = { state: "done", at: 1, interrupted: false };
const approving: PaneActivity = { state: "waiting", since: 1, reason: "permission" };

/** A long-enough clock advance to cross whatever deadline the manager armed,
 * when a test just wants the next pass to have run. */
const PAST_SPACING = 5_000;

/** The reply edge on the message with this body, read off the pane it was
 * sent to. Named rather than positional, and loud when it never landed. */
function edgeOn(
  h: ReturnType<typeof harness>,
  body: string,
): string | undefined {
  const sent = h.manager.takeAtTurnEnd("pane-1").filter((mail) => mail.body === body);
  expect(sent, `expected exactly one message saying "${body}"`).toHaveLength(1);
  return sent[0]?.replyTo;
}

function harness(options: { asksAtTurnEnd?: boolean } = {}) {
  let clock = 1_000;
  let wakeable = true;
  const activity = new Map<string, PaneActivity>();
  const listeners = new Set<() => void>();
  const channelWatchers = new Set<() => void>();
  /** Panes nudged into a turn, in order. A wake carries nothing, so this is
   * the only trace of one — and the terminal's one job now. */
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
    wake: (paneId) => {
      if (!wakeable) return false;
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
    woken,
    /** Set a pane's activity and tell the manager, as the tracker would. */
    reports(paneId: string, next: PaneActivity) {
      activity.set(paneId, next);
      for (const listener of [...listeners]) listener();
    },
    noChannel() {
      wakeable = false;
    },
    /** The terminal mounts: the registry says so, and NOTHING else does —
     * no status is emitted for it. */
    channelBack() {
      wakeable = true;
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
  it("wakes a pane that can take a nudge", () => {
    const h = harness();
    h.reports(B.paneId, done);
    const result = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "task",
      body: "rebase onto main",
    });
    expect(result).toEqual({ ok: true, id: "mail-1", delivered: false });
    expect(h.woken).toEqual([B.paneId]);
    // The nudge carried no words: the message stays in the queue until the
    // pane comes for it.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "rebase onto main",
    ]);
  });

  it("holds at a permission prompt and wakes the pane once it leaves", () => {
    const h = harness();
    h.reports(B.paneId, approving);
    const result = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "note",
      body: "careful with that one",
    });
    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(h.woken).toEqual([]);
    // The activity subscription is the whole retry mechanism: without it a
    // held message would wait for the expiry timer and then be dropped.
    h.reports(B.paneId, done);
    expect(h.woken).toEqual([B.paneId]);
  });

  it("does not nudge twice within one wait window", () => {
    // The old spacing kept two pastes from landing in one input buffer. The
    // same clock now paces the nudge: a pane is prodded at most once per
    // wait window, however many messages pile up behind the one it has not
    // answered.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "first" });
    expect(h.woken).toEqual([B.paneId]);
    const second = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "note",
      body: "second",
    });
    expect(second).toMatchObject({ ok: true, delivered: false });
    expect(h.woken).toEqual([B.paneId]);
    h.advance(MAIL_LIMITS.hookWaitMs);
    expect(h.woken).toEqual([B.paneId, B.paneId]);
  });

  it("expires a message nobody could take, and tells its sender", () => {
    const h = harness();
    h.reports(A.paneId, done);
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);

    h.advance(MAIL_LIMITS.undeliveredMs);
    // The question never reached B; A hears about it instead of waiting on
    // an answer that can no longer come.
    const notice = h.manager.takeAtTurnEnd(A.paneId)[0];
    expect(notice.kind).toBe("undelivered");
    expect(notice.from).toEqual({ kind: "host" });
    expect(notice.toPaneId).toBe(A.paneId);
    expect(notice.replyTo).toBe("mail-1");
  });

  it("tells a sender its message is waiting, once, and does not report on the report", () => {
    const h = harness();
    // Neither pane can take anything, so both the message and the notice sit
    // in their queues for as long as the test runs.
    h.reports(A.paneId, approving);
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(MAIL_LIMITS.undeliveredMs);
    h.advance(MAIL_LIMITS.undeliveredMs * 3);
    // The prompts clear, and A hears exactly one word about it: a notice
    // that minted another notice would keep the queue alive forever, and the
    // only thing stopping that is that a report about a report is refused by
    // kind.
    h.reports(A.paneId, done);
    h.reports(B.paneId, done);
    h.advance(PAST_SPACING);
    const notices = h.manager
      .takeAtTurnEnd(A.paneId)
      .filter((mail) => mail.kind === "undelivered");
    expect(notices).toHaveLength(1);
    // And the message itself still lands. It was late, never lost.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toContain("which port?");
  });

  it("lets an A↔B exchange run for as long as the work takes", () => {
    // The field incident this exists against: a depth counter refused the
    // ninth message of an ordinary exchange, and the pane it refused stayed
    // mute toward the whole deck until its process restarted. An implementer
    // finished its task and could not report it. A team left to work
    // unattended is the POINT of the feature, and it talks far more than
    // nine times.
    const h = harness();
    h.reports(A.paneId, done);
    h.reports(B.paneId, done);

    let from = A;
    let to = B;
    const results = [];
    for (let round = 0; round < 40; round += 1) {
      results.push(
        h.manager.send({
          from,
          toPaneId: to.paneId,
          kind: "question",
          body: `round ${round}`,
        }),
      );
      h.advance(PAST_SPACING);
      [from, to] = [to, from];
    }

    expect(results.filter((result) => result.ok)).toHaveLength(results.length);
    expect(h.manager.takeAtTurnEnd(A.paneId).map((mail) => mail.body)).toContain("round 39");
  });

  it("wakes a pane that has never reported anything at all", () => {
    // The live failure this exists for: a status reporter speaks on turn
    // events, so an idle pane reports NOTHING, and a task to a teammate
    // sitting at its prompt is exactly the message that must still be
    // announced.
    const h = harness();
    const result = h.manager.send({
      from: A,
      toPaneId: "pane-silent",
      kind: "task",
      body: "review the parser",
    });
    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(h.woken).toEqual(["pane-silent"]);
  });

  it("waits for the terminal to MOUNT before nudging, which no status ever announces", () => {
    // A pane can be alive and silent, so the channel's refusal is the only
    // thing that says "not writable yet" — and its recovery is the
    // registry, not an activity edge that may never come.
    const h = harness();
    h.noChannel();
    const result = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "go" });
    expect(result).toMatchObject({ ok: true, delivered: false });
    expect(h.woken).toEqual([]);
    // No status is reported here on purpose — the mount alone must do it.
    h.channelBack();
    expect(h.woken).toEqual([B.paneId]);
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
    // Nudged, never pushed: the words are still in the queue.
    expect(h.woken).toEqual([B.paneId]);
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

  it("counts what a pane has not been given, queued and delivered alike", () => {
    // What the hand-over frame tells the agent. Both halves count: the
    // budget leaves messages queued, and a message a restart un-read sits in
    // the journal counting too.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "one" });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "two" });
    expect(h.manager.waiting(B.paneId)).toBe(2);
    h.manager.takeAtTurnEnd(B.paneId);
    expect(h.manager.waiting(B.paneId)).toBe(0);
  });

  it("takes from the queue only as far as its answer carries", () => {
    // Emptying it wholesale put the remainder in a journal the turn-boundary
    // hand-over cannot see, so what the budget left behind was stranded —
    // while the frame went on telling the agent it would arrive at the next
    // boundary. A briefing, whose only channel IS that hand-over, was lost
    // outright.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "task",
      body: "x".repeat(MAIL_LIMITS.handoverChars),
    });
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    expect(h.manager.inbox(B.paneId).messages).toHaveLength(1);
    // Still queued, so the boundary still reaches it — which is what the
    // agent was promised.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual(["team"]);
  });

  it("stops nudging once the sender has been told the message is waiting", () => {
    // Expiry used to end this by destroying the message; without it the
    // throttle only paced an endless prod at a pane plainly not listening.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(MAIL_LIMITS.undeliveredMs * 4);
    const nudges = h.woken.length;
    expect(nudges).toBeGreaterThan(0);
    h.advance(MAIL_LIMITS.undeliveredMs * 4);
    h.reports(B.paneId, done);
    expect(h.woken).toHaveLength(nudges);
  });

  it("arms no timer for a message that is only waiting on an event", () => {
    // The deadline these branches used to return was the instant the message
    // expired. With nothing expiring it is a fixed point sliding into the
    // past, and the 1 ms floor then re-armed the timer about a thousand
    // times a second, forever.
    //
    // Both panes hold on prompts: the sender's too, or its overdue notice
    // would arm a wake deadline of its own and this test would be asserting
    // about the wrong timer.
    const h = harness();
    h.reports(A.paneId, approving);
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    h.advance(MAIL_LIMITS.undeliveredMs * 2);
    expect(h.pending()).toBeNull();
  });

  it("keeps the briefing when a flood overruns the queue, and drops traffic instead", () => {
    // Standing context is exempt from every other clock here for one reason:
    // a pane reading its teammates' mail without knowing who is asking is
    // worse off than one kept waiting. A cap that evicted it to make room
    // for traffic would be that exemption undone.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 2 });
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    for (let i = 0; i < 60; i += 1) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: `note ${i}` });
    }
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toContain("team");
  });

  it("does not let a full queue turn one overflow into two emptied queues", () => {
    // The drop notice used to be enqueued through the same cap, so it could
    // displace a message in the SENDER's queue, minting another notice, and
    // so on: one send over the line destroyed a hundred real messages.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(A.paneId, { state: "working", since: 2 });
    h.reports(B.paneId, { state: "working", since: 2 });
    for (let i = 0; i < 60; i += 1) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: `a${i}` });
      h.manager.send({ from: B, toPaneId: A.paneId, kind: "note", body: `b${i}` });
    }
    const real = (paneId: string) =>
      h.manager.takeAtTurnEnd(paneId).filter((mail) => mail.kind === "note");
    expect(real(A.paneId).length).toBeGreaterThan(0);
    expect(real(B.paneId).length).toBeGreaterThan(0);
  });

  it("does not report a message waiting twice because a hand-over came back", () => {
    // The report is once per message, not once per stay in a queue. An id is
    // forgotten only when the message is gone for good — leaving the queue
    // for a hand-over is not that, since the transport can put it back with
    // its clock untouched.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(A.paneId, done);
    h.reports(B.paneId, { state: "working", since: 2 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(MAIL_LIMITS.undeliveredMs * 2);
    const taken = h.manager.takeAtTurnEnd(B.paneId);
    expect(taken).toHaveLength(1);
    h.manager.restore(taken);
    h.advance(MAIL_LIMITS.undeliveredMs * 2);
    expect(h.manager.takeAtTurnEnd(A.paneId).filter((m) => m.kind === "undelivered")).toHaveLength(
      1,
    );
  });

  it("leaves a restarted process nothing it has already answered", () => {
    // A restart un-reads what the dead process had read, because its context
    // went with it. What it ANSWERED is a fact about the pane, not about the
    // process — reopening it would offer the ask again and invite a second
    // answer to the same question.
    const h = harness({ asksAtTurnEnd: true });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.takeAtTurnEnd(B.paneId);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    h.manager.clear(B.paneId);
    expect(h.manager.inbox(B.paneId).messages).toEqual([]);
  });

  it("counts a message a restart un-read as still waiting", () => {
    // Both halves of the sum matter: the queue holds what was never handed
    // over, and the journal holds what the current generation has not
    // confirmed — which is exactly what `clear` un-reads on a restart.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    h.manager.takeAtTurnEnd(B.paneId);
    expect(h.manager.waiting(B.paneId)).toBe(0);
    h.manager.clear(B.paneId);
    expect(h.manager.waiting(B.paneId)).toBe(1);
    h.manager.inbox(B.paneId);
    expect(h.manager.waiting(B.paneId)).toBe(0);
  });

  it("gives a restarted process a clean nudge cooldown, not its predecessor's", () => {
    // `clear` promises the next process has forgotten everything. The
    // cooldown describes the process that just retired — it exists because a
    // nudge into a live turn is already queued and repeating it costs the
    // pane a turn per repeat — so a fresh one inheriting it would sit out a
    // silence it never earned, and it is the pane most in need of a nudge.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "one" });
    expect(h.woken).toEqual([B.paneId]);
    h.manager.clear(B.paneId);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "two" });
    // Nudged again at once: the cooldown belonged to the dead process.
    expect(h.woken).toEqual([B.paneId, B.paneId]);
  });

  it("forgets panes that are gone", () => {
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "one" });
    expect(h.manager.inbox(B.paneId).messages).toHaveLength(1);
    h.manager.retain(new Set([A.paneId]));
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toEqual([]);
  });

  it("keeps nudging for newer mail once an older message has stopped earning it", () => {
    // A queue is oldest-first and nothing expires any more, so a message that
    // has crossed the report window sits at its head for good. Stopping the
    // walk there silenced the pane for everything BEHIND it, permanently: the
    // prompt clears, the pane goes idle, and nothing ever prods it again.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "old" });
    const nudges = () => h.woken.filter((paneId) => paneId === B.paneId).length;
    expect(nudges()).toBe(1);
    h.advance(MAIL_LIMITS.undeliveredMs * 2);
    const spent = nudges();
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "new" });
    expect(nudges()).toBeGreaterThan(spent);
  });

  it("leaves no queue behind for a pane it has just forgotten", () => {
    // A report goes INTO its recipient's queue, so reporting while pruning
    // recreated a queue keyed to a pane this same call had already deleted.
    // `pane-N` is a slot the next pane inherits, and that agent would be
    // handed a delivery report about a message it never sent.
    const h = harness();
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "for a pane on its way out" });
    h.manager.retain(new Set());
    expect(h.manager.waiting(A.paneId)).toBe(0);
    expect(h.manager.waiting(B.paneId)).toBe(0);
  });

  it("still tells a LIVING sender that the pane it wrote to is gone", () => {
    // The other half of the rule above: silence is only owed to a sender
    // that has gone too.
    const h = harness();
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "one" });
    h.manager.retain(new Set([A.paneId]));
    expect(h.manager.inbox(A.paneId).messages.map((mail) => mail.kind)).toEqual([
      "undelivered",
    ]);
  });

  it("refuses a pane mailing itself before anything is queued", () => {
    const h = harness();
    h.reports(A.paneId, done);
    expect(
      h.manager.send({ from: A, toPaneId: A.paneId, kind: "note", body: "hi me" }),
    ).toEqual({ ok: false, refusal: { kind: "self-addressed" } });
    expect(h.woken).toEqual([]);
    expect(h.manager.inbox(A.paneId, { all: true }).messages).toEqual([]);
  });

  it("waits out a running turn when the agent will come asking", async () => {
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    const result = h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    expect(result).toMatchObject({ ok: true, delivered: false });
    // Not pushed into a running turn: the labelled channel is coming, and the
    // message stays queued for it.
    expect(h.manager.waiting(B.paneId)).toBe(1);
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
    // The nudge carried no words: the answer is still in the queue.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual(["done"]);
  });

  it("nudges a working pane for something that expects an answer", () => {
    // The terminal's whole remaining job for an agent that can receive mail
    // properly. Pushing the message itself is what left a teammate's task
    // sitting unsent in a composer, indistinguishable from a delivery; a
    // nudge that fails loses a keystroke and the message is still queued.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(MAIL_LIMITS.hookWaitMs);
    expect(h.woken).toEqual([B.paneId]);
    // NOTHING was handed over, and the message is still there for the turn
    // the nudge is about to start.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "which port?",
    ]);
  });

  it("lets a working pane finish, for mail that expects nothing back", () => {
    // The clock used to apply to every kind, so a pane still working after
    // the wait fell through to a nudge — into a RUNNING turn, where it lands
    // in the input queue and fires a turn of its own later. A ten-minute
    // build collected one of those every 45 seconds, and the message was
    // dropped at the end anyway.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "CI is red on main" });
    h.advance(MAIL_LIMITS.hookWaitMs * 4);
    // Drive a pass explicitly, with the clock long past the wait. Relying on
    // an armed timer would prove nothing: routine mail arms none, so the
    // assertion would hold even if the rule under test were gone.
    h.reports(B.paneId, { state: "working", since: 500 });
    expect(h.woken).toEqual([]);
    // It is waiting, not lost: the boundary this turn is heading for hands
    // it over.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "CI is red on main",
    ]);
  });

  it("does not queue a second nudge behind one a running turn has not answered yet", () => {
    // A nudge into a running turn is not lost — it is in the CLI's input
    // queue and will fire a turn on its own. Repeating it queues another,
    // and the pane pays for every one when the current turn ends.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    expect(h.woken).toEqual([B.paneId]);
    h.reports(B.paneId, { state: "working", since: 2 });
    h.advance(MAIL_LIMITS.hookWaitMs * 3);
    expect(h.woken).toEqual([B.paneId]);
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
    expect(h.woken).toEqual([]);
  });

  it("keeps a long-waiting message for the turn that finally comes", () => {
    // The case the old clock destroyed: a pane working through something
    // long. Its sender is told the message is waiting, and the message is
    // still there when the turn ends.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(A.paneId, done);
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.advance(MAIL_LIMITS.undeliveredMs * 3);
    expect(h.manager.takeAtTurnEnd(A.paneId).map((mail) => mail.kind)).toEqual([
      "undelivered",
    ]);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body)).toEqual([
      "which port?",
    ]);
  });

  it("drops the oldest when a queue has grown past what a pane will ever collect", () => {
    // The one bound left, and it replaces the one age used to provide. The
    // sender is told, because this is now the only way a message is really
    // lost.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(A.paneId, done);
    h.reports(B.paneId, { state: "working", since: 500 });
    for (let i = 0; i < 51; i += 1) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: `note ${i}` });
    }
    const bodies = h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.body);
    expect(bodies).not.toContain("note 0");
    expect(bodies).toContain("note 50");
    expect(h.manager.takeAtTurnEnd(A.paneId).map((mail) => mail.kind)).toEqual([
      "undelivered",
    ]);
  });

  it("lets the deck speak for itself, as the host rather than as a pane", () => {
    // The host already speaks for delivery reports; a team briefing is the
    // other thing only the deck knows. It has to arrive as the DECK: named
    // as a pane it would be a teammate's words, which the briefing itself
    // tells the agent to weigh rather than obey.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    const [briefing] = h.manager.takeAtTurnEnd(B.paneId);
    expect(briefing.from).toEqual({ kind: "host" });
    expect(briefing.kind).toBe("team");
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
    // Not even nudged: a briefing is context, not a summons, and it waits for
    // the labelled channel however ready the pane is.
    expect(h.woken).toEqual([]);
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
    // pane — so it must not stand in front of the nudge that carries the
    // task's summons.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "task",
      body: "take the parser",
    });
    // The task is announced despite the briefing ahead of it, and neither
    // was consumed by the walk.
    expect(h.woken).toEqual([B.paneId]);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
      "task",
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
    h.advance(MAIL_LIMITS.undeliveredMs * 12);
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
      "task",
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
    // Not even nudged: a briefing cannot go stale, so it does not wake the
    // pane either — it is still there for whatever turn finally happens.
    expect(h.woken).toEqual([]);
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

  it("holds a task at a permission prompt, and wakes the pane once that clears", () => {
    // The one dangerous state stays dangerous: keystrokes at a permission
    // prompt pick menu items, so even a nudge is held back until it is safe
    // to type at all.
    const h = harness();
    h.reports(B.paneId, approving);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "take the parser" });
    expect(h.woken).toEqual([]);
    h.reports(B.paneId, done);
    expect(h.woken).toEqual([B.paneId]);
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
    expect(h.woken).toEqual([]);
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

  it("forgets what a dead teammate was owed, in the journals of the living", () => {
    // A debt names its creditor by pane id, and `pane-N` is a slot a later
    // pane inherits. Pruning only by receiver left the reference behind, so
    // an answer arrived at a fresh agent labelled a reply to a question it
    // never asked.
    const h = asking();
    ask(h, "which port?");
    collect(h, B);
    h.manager.retain(new Set([B.paneId, C.paneId]));
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeAt(h, A, "8080")).toBeUndefined();
  });

  it("does not resurrect a briefing a restart has already been re-told", () => {
    // The deck re-states standing context on every fresh session. Un-reading
    // the old one leaves the pane holding two, and the newer arrives already
    // read — so a catch-up handed back the stale one alone.
    const h = asking();
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    collect(h, B);
    h.manager.clear(B.paneId);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    collect(h, B);
    expect(h.manager.inbox(B.paneId).messages).toEqual([]);
  });

  it("re-reads the recent end of the journal, and does not invite another call", () => {
    // `all` cannot page — there is no cursor — so taking from the front left
    // the newest permanently unreachable while advising a call that returned
    // the same thing again. An agent whose context was rebuilt wants where
    // things stand now.
    const h = asking();
    for (const body of ["one", "two", "three"]) {
      h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body });
    }
    h.manager.inbox(B.paneId);
    const again = h.manager.inbox(B.paneId, { all: true });
    expect(again.messages.map((mail) => mail.body)).toEqual(["one", "two", "three"]);
    expect(again.waiting).toBe(0);
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
  it("does not treat a message a restart un-read as read", () => {
    // The only thing that produces an `unread` entry now is `clear`: a
    // restart un-reads what the dead process had read, because its context
    // went with it. Calling that read would be the deck guessing — an
    // answer must only be tied to what the current generation actually came
    // for.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.takeAtTurnEnd(B.paneId);
    h.manager.clear(B.paneId);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBeUndefined();
  });

  it("counts the agent going to look as reading", () => {
    // The same message, once its agent asks for its mail after a restart.
    // That ask is the event the deck can witness, and it is what turns an
    // un-read message back into something the agent can be answering.
    const h = harness();
    h.reports(B.paneId, done);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.takeAtTurnEnd(B.paneId);
    h.manager.clear(B.paneId);
    h.manager.inbox(B.paneId);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBe("mail-1");
  });
});

describe("a journal that cannot hold everything", () => {
  function fill(h: ReturnType<typeof harness>, from: MailSender, count: number): void {
    for (let i = 0; i < count; i += 1) {
      h.manager.send({ from, toPaneId: B.paneId, kind: "question", body: `${from.paneId} q${i}` });
    }
  }

  it("never spends what has just arrived", () => {
    // The arrival is the one entry that cannot be history yet. Spending it
    // told an `all: true` read the pane was never handed the message — while
    // its agent was reading that very message.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    fill(h, C, 50);
    h.manager.inbox(B.paneId);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "the newest thing" });
    h.manager.inbox(B.paneId);
    const bodies = h.manager.inbox(B.paneId, { all: true }).messages.map((mail) => mail.body);
    expect(bodies).toContain("the newest thing");
  });

  it("keeps both teammates' open asks rather than losing the older one", () => {
    // Losing an open ask does not merely forget it. It turns an honest "two
    // are waiting, so name neither" into a confident edge to whichever
    // survived — and tells the other sender its message went nowhere, while
    // the receiver is holding it.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    // Fill FIRST: the queue caps at 50, and the two A-asks this test is
    // about must not be the oldest thing evicted to make room for the flood.
    fill(h, C, 50);
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "and the host?" });
    h.manager.inbox(B.paneId);
    h.reports(A.paneId, done);
    // No ask was spent: A has heard nothing but silence.
    expect(
      h.manager.inbox(A.paneId).messages.filter((mail) => mail.kind === "undelivered"),
    ).toEqual([]);
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    expect(edgeOn(h, "8080")).toBeUndefined();
  });

  it("tells a sender the deck has FORGOTTEN its message, not that it never arrived", () => {
    // At the ceiling an ask does go, and what its sender is told has to be
    // actionable: it arrived, it was never answered, and an answer now will
    // not be tied back to it. "Never collected" would send that agent
    // looking for a delivery failure that did not happen.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    // A cannot take the notices, so they stay where an explicit read will
    // find them rather than racing the drain.
    h.reports(A.paneId, approving);
    // Batched so the queue never overflows: the ceiling is about the
    // JOURNAL, and a Dropped notice from a full queue would masquerade as
    // the Forgotten one this test is here to distinguish.
    for (let round = 0; round < 5; round += 1) {
      fill(h, A, 50);
      h.manager.inbox(B.paneId);
    }
    const notices = h.manager
      .inbox(A.paneId)
      .messages.filter((mail) => mail.kind === "undelivered");
    expect(notices).not.toEqual([]);
    expect(notices[0].body).toContain("Forgotten");
    expect(notices[0].body).not.toContain("never collected");
  });
});

describe("taking a message back", () => {
  it("cancels one still waiting in the queue", () => {
    // The plain case: nobody has come for it, so nobody has seen it.
    const h = harness();
    const sent = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "ship it" });
    expect(sent.ok).toBe(true);
    const id = sent.ok ? sent.id : "";

    expect(h.manager.cancel(A.paneId, id)).toEqual({ kind: "cancelled" });
    expect(h.manager.inbox(B.paneId).messages).toEqual([]);
    expect(h.manager.waiting(B.paneId)).toBe(0);
  });

  it("refuses once the message is in a running process's context", () => {
    // Asking for it IS reading it, and the deck does not rewrite what an
    // agent has already read.
    const h = harness();
    const sent = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "ship it" });
    const id = sent.ok ? sent.id : "";
    h.manager.inbox(B.paneId);

    expect(h.manager.cancel(A.paneId, id)).toEqual({ kind: "too-late" });
  });

  it("cancels a message whose reader has since restarted", () => {
    // The whole reason `unread` is cancellable: the process that read it is
    // gone and its context with it, so the words are in nobody's head. Only a
    // catch-up could put them back in one, and that is what this stops.
    const h = harness();
    const sent = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "ship it" });
    const id = sent.ok ? sent.id : "";
    h.manager.inbox(B.paneId);
    h.manager.clear(B.paneId);

    expect(h.manager.cancel(A.paneId, id)).toEqual({ kind: "cancelled" });
    // And the catch-up it would have arrived on now carries nothing.
    expect(h.manager.inbox(B.paneId, { all: true }).messages).toEqual([]);
    expect(h.manager.waiting(B.paneId)).toBe(0);
  });

  it("will not let a pane cancel what it did not send", () => {
    // The id is the agent's word. Without this, a pane could walk the ids and
    // destroy a conversation it was never part of.
    const h = harness();
    const sent = h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "ship it" });
    const id = sent.ok ? sent.id : "";

    expect(h.manager.findSent(C.paneId, id)).toBeUndefined();
    expect(h.manager.cancel(C.paneId, id)).toEqual({ kind: "too-late" });
    // Untouched: still waiting for the pane it was addressed to.
    expect(h.manager.inbox(B.paneId).messages.map((mail) => mail.body)).toEqual(["ship it"]);
  });

  it("gives the asker its debt back when an answer is cancelled", () => {
    // The edge is drawn when an answer is SENT, not when it lands. Taking the
    // answer back without this leaves the asker marked answered, no longer
    // counted as waiting, and owed a correction nobody knows to write.
    const h = harness();
    const ask = h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    const askId = ask.ok ? ask.id : "";
    h.manager.inbox(B.paneId);
    const answer = h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });

    expect(h.manager.cancel(B.paneId, answer.ok ? answer.id : "")).toEqual({
      kind: "cancelled",
    });
    // B owes A an answer again: a second one draws the edge back to the same
    // ask, which it could not do if that ask were still marked answered.
    h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8081" });
    expect(edgeOn(h, "8081")).toBe(askId);
  });

  it("leaves an unrelated ask alone when one answer is cancelled", () => {
    // Two teammates waiting on the same pane. Reopening must find the debt
    // the cancelled answer closed and no other.
    const h = harness();
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "question", body: "which port?" });
    h.manager.send({ from: C, toPaneId: B.paneId, kind: "question", body: "which host?" });
    h.manager.inbox(B.paneId);
    const toA = h.manager.send({ from: B, toPaneId: A.paneId, kind: "answer", body: "8080" });
    h.manager.send({ from: B, toPaneId: C.paneId, kind: "answer", body: "localhost" });

    h.manager.cancel(B.paneId, toA.ok ? toA.id : "");
    // C's ask stays closed — B answered it and did not take that back, so a
    // second message to C answers nothing and carries no edge.
    h.manager.send({ from: B, toPaneId: C.paneId, kind: "answer", body: "127.0.0.1" });
    const toCagain = h.manager
      .takeAtTurnEnd(C.paneId)
      .filter((mail) => mail.body === "127.0.0.1");
    expect(toCagain).toHaveLength(1);
    expect(toCagain[0].replyTo).toBeUndefined();
  });
});
