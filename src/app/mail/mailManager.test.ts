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

  it("falls back to the terminal when the turn outlasts the wait", () => {
    // A turn can run far longer than a correction stays useful. Waiting is
    // bounded precisely so a message is never lost to the waiting.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, { state: "working", since: 500 });
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "note", body: "careful" });
    expect(h.delivered).toHaveLength(0);
    h.advance(MAIL_LIMITS.hookWaitMs);
    expect(h.delivered.map((mail) => mail.body)).toEqual(["careful"]);
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
    // sender still hears about it.
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);
    expect(h.delivered.map((mail) => mail.kind)).toEqual(["undelivered"]);
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

  it("lets a task past a briefing that is still waiting for its channel", () => {
    // Head-of-line blocking, seen live: a lead's pings to two teammates both
    // came back `delivered: false`, sitting behind briefings restated at
    // session start that nothing had collected. A briefing waits for a
    // DIFFERENT channel — that is a fact about the message, not about the
    // pane — so it must not stand in front of what the terminal can carry.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    const sent = h.manager.send({
      from: A,
      toPaneId: B.paneId,
      kind: "task",
      body: "take the parser",
    });
    expect(sent).toMatchObject({ ok: true, delivered: true });
    expect(h.delivered.map((mail) => mail.kind)).toEqual(["task"]);
    // And the briefing kept its place rather than being consumed with it.
    expect(h.manager.takeAtTurnEnd(B.paneId).map((mail) => mail.kind)).toEqual([
      "team",
    ]);
  });

  it("still expires a briefing it stepped over, on that briefing's own clock", () => {
    // Stepping over a message must not cost it its timer: the walk can end
    // with nothing deliverable behind it, and the only thing left to
    // schedule is the moment the skipped one stops being worth holding.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are impl-1 on api");
    h.manager.send({ from: A, toPaneId: B.paneId, kind: "task", body: "take it" });
    expect(h.delivered).toHaveLength(1);
    h.advance(MAIL_LIMITS.undeliveredMs);
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);
  });

  it("drops a briefing nobody asked for rather than typing it in late", () => {
    // The wait is bounded like every other, and the end of it is NOT a
    // fallback to the terminal — that fallback is exactly what this kind
    // has no business using. It expires quietly: the deck said it to a pane
    // that never came asking, and there is no sender owed a report.
    const h = harness({ asksAtTurnEnd: true });
    h.reports(B.paneId, done);
    h.manager.announce(B.paneId, "team", "you are lead on api");
    h.advance(MAIL_LIMITS.undeliveredMs);
    expect(h.delivered).toHaveLength(0);
    expect(h.manager.takeAtTurnEnd(B.paneId)).toEqual([]);
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
