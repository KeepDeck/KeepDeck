import { describe, expect, it } from "vitest";
import type { PaneActivity } from "../status";
import type { Mail, MailSender } from "./message";
import type { MailKind } from "./message";
import {
  MAIL_LIMITS,
  awaitsAnswer,
  decideDelivery,
  decideHandover,
  decideSend,
  droppedNotice,
  isOverdue,
  isResponse,
  overdueNotice,
} from "./policy";

const sender: MailSender = {
  paneId: "pane-1",
  workspaceId: "ws-1",
  label: "Agent 1",
};

const SENT_AT = 1_000;

function mail(over: Partial<Mail> = {}): Mail {
  return {
    id: "mail-1",
    kind: "question",
    body: "which signature does the port take?",
    from: { kind: "pane", pane: sender },
    toPaneId: "pane-2",
    at: SENT_AT,
    hop: 0,
    ...over,
  };
}

const working: PaneActivity = { state: "working", since: 1 };
const asking: PaneActivity = { state: "waiting", since: 1, reason: "question" };
const approving: PaneActivity = { state: "waiting", since: 1, reason: "permission" };
const done: PaneActivity = { state: "done", at: 1, interrupted: false };
const failed: PaneActivity = { state: "failed", at: 1, error: "rate_limit" };

describe("what a kind means for an answer", () => {
  // The whole vocabulary in one table, because the two predicates are each
  // other's mirror and the pair is only right if read together: what leaves
  // the reader owing a response, and what pays that off. A kind added to the
  // union without a row here is a compile error at the table, which is the
  // point of writing it out rather than testing two or three cases.
  const kinds: Array<[MailKind, { awaits: boolean; responds: boolean }]> = [
    // A work order and a question each expect something back.
    ["task", { awaits: true, responds: false }],
    ["question", { awaits: true, responds: false }],
    // An answer closes what the sender was asked, and opens nothing.
    ["answer", { awaits: false, responds: true }],
    // A note merely informs — nobody is waiting on it.
    ["note", { awaits: false, responds: false }],
    // The deck's own voice. An agent can send neither, and neither can be
    // answered: there is no pane behind them.
    ["undelivered", { awaits: false, responds: false }],
    ["team", { awaits: false, responds: false }],
  ];

  for (const [kind, expected] of kinds) {
    it(`${kind}: ${expected.awaits ? "awaits an answer" : "awaits nothing"}, ${
      expected.responds ? "is a response" : "is not a response"
    }`, () => {
      expect(awaitsAnswer(kind)).toBe(expected.awaits);
      expect(isResponse(kind)).toBe(expected.responds);
    });
  }

  it("never counts one kind as both an open ask and its own answer", () => {
    // The two halves of one rule: something that closes a debt cannot also
    // create one, or a pair would owe each other forever on one message.
    for (const [kind] of kinds) {
      expect(awaitsAnswer(kind) && isResponse(kind)).toBe(false);
    }
  });
});

describe("decideDelivery", () => {
  it("delivers into a running turn — steering is the normal mode, not an intrusion", () => {
    expect(decideDelivery(mail(), working, SENT_AT)).toEqual({ kind: "deliver" });
  });

  it("delivers to a pane parked on a question, which the message probably answers", () => {
    expect(decideDelivery(mail(), asking, SENT_AT)).toEqual({ kind: "deliver" });
  });

  it("delivers to a finished pane, starting a new turn", () => {
    expect(decideDelivery(mail(), done, SENT_AT)).toEqual({ kind: "deliver" });
    expect(decideDelivery(mail(), failed, SENT_AT)).toEqual({ kind: "deliver" });
  });

  it("holds a briefing whatever the pane is doing — it may only arrive labelled", () => {
    // A briefing is context, not a summons: pasted into a composer it reads
    // as something the person typed, which contradicts the only thing it
    // says. There is no receiver state that makes typing it in acceptable,
    // so this outranks every rule below — including the ones that would
    // otherwise deliver.
    const briefing = mail({ kind: "team" });
    for (const activity of [working, asking, done, failed, undefined]) {
      expect(decideDelivery(briefing, activity, SENT_AT)).toEqual({
        kind: "hold",
        reason: "labelled-only",
      });
    }
    // Forever, for an agent that has no labelled channel: there is no later
    // moment at which typing it in becomes acceptable.
    const late = SENT_AT + MAIL_LIMITS.hookWaitMs;
    expect(decideDelivery(briefing, done, late)).toEqual({
      kind: "hold",
      reason: "labelled-only",
    });
    // And having a labelled channel does not change it: a nudge is a
    // keystroke too, and spending one to make an agent come asking for pure
    // context is the same intrusion in a thinner disguise. A starting agent
    // gets its briefing from its own SessionStart instead.
    for (const activity of [working, done, undefined]) {
      expect(
        decideDelivery(briefing, activity, late, MAIL_LIMITS, true),
        String(activity?.state),
      ).toEqual({ kind: "hold", reason: "labelled-only" });
    }
    // And it keeps NO clock. A briefing cannot go stale — it is as true an
    // hour later — while an agent that takes no turn for an hour is exactly
    // the one that would lose it and then be handed a teammate's task with
    // no idea who is asking.
    expect(
      decideDelivery(briefing, done, SENT_AT + MAIL_LIMITS.undeliveredMs * 12),
    ).toEqual({ kind: "hold", reason: "labelled-only" });
  });

  it("still types in what a pane is meant to ACT on", () => {
    // The counterpart, and the reason the rule above is about kinds rather
    // than about the deck being the speaker: a task, an answer or a delivery
    // report exists to move the receiver, and the terminal is the only thing
    // that wakes an idle CLI.
    for (const kind of ["task", "question", "answer", "note", "undelivered"] as const) {
      expect(decideDelivery(mail({ kind }), done, SENT_AT)).toEqual({
        kind: "deliver",
      });
    }
  });

  it("holds at a permission prompt — the one state where text answers a menu", () => {
    expect(decideDelivery(mail(), approving, SENT_AT)).toEqual({
      kind: "hold",
      reason: "permission",
    });
  });

  it("tries a pane that reports nothing, rather than waiting on it", () => {
    // The bug that made the feature look broken. A status reporter speaks
    // on turn events, so a pane sitting idle at its prompt reports NOTHING
    // — and holding it meant waiting for an activity change a silent pane
    // never produces. Observed live: a task to an idle teammate sat
    // undelivered until a person typed into it by hand. Whether it can
    // actually take the message is the channel's question, and the channel
    // is the one thing that can answer it.
    expect(decideDelivery(mail(), undefined, SENT_AT)).toEqual({ kind: "deliver" });
  });

  it("decides the same thing however long a message has waited", () => {
    // Age used to outrank every verdict here, and a message older than the
    // window was destroyed: a teammate running a ten-minute build lost
    // everything written to it, on the argument that a correction arriving
    // after the action it meant to stop is worse than none. That argument is
    // the RECEIVER's to make — it is the only party that knows what the
    // message says — so the clock moved out of this decision entirely and
    // became something the SENDER is told ([`isOverdue`]).
    const fresh = mail();
    const old = mail({ at: 0 });
    const late = MAIL_LIMITS.undeliveredMs * 10;
    for (const activity of [working, asking, done, failed, approving, undefined]) {
      expect(decideDelivery(old, activity, late), String(activity?.state)).toEqual(
        decideDelivery(fresh, activity, late),
      );
    }
  });

  it("holds right up to the boundary — the cutoff is inclusive of the limit only", () => {
    const justInTime = SENT_AT + MAIL_LIMITS.undeliveredMs - 1;
    expect(decideDelivery(mail(), approving, justInTime)).toEqual({
      kind: "hold",
      reason: "permission",
    });
    expect(decideDelivery(mail(), working, justInTime)).toEqual({ kind: "deliver" });
  });

  it("waits for a turn boundary when the agent will come asking", () => {
    // The channel split: a running turn is the one state where a BETTER way
    // in is coming, because the agent asks the deck when the turn ends and
    // an answer given there is labelled rather than pasted.
    expect(decideDelivery(mail(), working, SENT_AT, MAIL_LIMITS, true)).toEqual({
      kind: "hold",
      reason: "turn-boundary",
    });
  });

  it("stops waiting and NUDGES rather than losing the message", () => {
    // A turn can run far longer than a course correction stays useful, so
    // the wait is bounded. What the terminal does at the end of it is wake
    // the pane, not carry the words: the turn that starts fires the hook,
    // and the hook delivers properly.
    const spent = SENT_AT + MAIL_LIMITS.hookWaitMs;
    expect(decideDelivery(mail(), working, spent, MAIL_LIMITS, true)).toEqual({
      kind: "wake",
    });
  });

  it("waits only while a turn is RUNNING — nothing else brings a boundary", () => {
    // Waiting buys a free ride on a boundary that is coming anyway. An idle
    // agent fires no hook, so waiting on one is pure latency: measured at
    // exactly 45 seconds for a lead's three answers, which arrived 11
    // seconds after it had stopped.
    expect(decideDelivery(mail(), working, SENT_AT, MAIL_LIMITS, true)).toEqual({
      kind: "hold",
      reason: "turn-boundary",
    });
    for (const activity of [done, failed, asking, undefined]) {
      expect(
        decideDelivery(mail(), activity, SENT_AT, MAIL_LIMITS, true),
        String(activity?.state),
      ).toEqual({ kind: "wake" });
    }
    // ...and a permission prompt outranks it, hook or not.
    expect(decideDelivery(mail(), approving, SENT_AT, MAIL_LIMITS, true)).toEqual({
      kind: "hold",
      reason: "permission",
    });
  });

  it("nudges once the wait for a hook is spent", () => {
    // The bound is what keeps the preference from becoming a trap: an idle
    // agent fires no hook, so waiting longer only runs the clock out. The
    // nudge buys a turn, and the turn is what carries the message.
    const late = SENT_AT + MAIL_LIMITS.hookWaitMs;
    expect(decideDelivery(mail(), done, late, MAIL_LIMITS, true)).toEqual({
      kind: "wake",
    });
    // And the wait is strictly shorter than the life of the message, or the
    // fallback would never get a turn.
    expect(MAIL_LIMITS.hookWaitMs).toBeLessThan(MAIL_LIMITS.undeliveredMs);
  });


  it("reads the limits it is given, not only the shipped ones", () => {
    // Guards against the bound being read from the module constant instead
    // of the argument — a bug no default-limits test can see.
    const limits = {
      undeliveredMs: 10,
      maxHops: 1,
      hookWaitMs: 5,
      handoverChars: 100,
    };
    // The wait before a nudge is the one bound this decision still reads.
    const asking = mail({ kind: "question" });
    expect(decideDelivery(asking, working, SENT_AT + 5, limits, true)).toEqual({
      kind: "wake",
    });
    expect(decideDelivery(asking, working, SENT_AT + 4, limits, true)).toEqual({
      kind: "hold",
      reason: "turn-boundary",
    });
    expect(isOverdue(mail(), SENT_AT + 10, limits)).toBe(true);
    expect(isOverdue(mail(), SENT_AT + 9, limits)).toBe(false);
  });
});

describe("decideHandover", () => {
  it("shares the one clause it has with the terminal's verdict, rather than copying it", () => {
    // A pane parked on a permission prompt is unsafe to push at through
    // either door. Copied into the application owner once, it made a reason
    // to hold that the terminal path honoured and this one — the path a
    // briefing exclusively uses — silently ignored.
    expect(decideHandover(approving)).toBe("hold");
    expect(decideDelivery(mail(), approving, SENT_AT)).toEqual({
      kind: "hold",
      reason: "permission",
    });
    expect(decideHandover(done)).toBe("hand");
  });

  it("hands over the standing context the other channel refuses to touch", () => {
    // The one place the two verdicts MUST differ: a briefing is held from the
    // terminal forever and delivered here, because this is the moment it was
    // waiting for.
    const briefing = mail({ kind: "team", at: 0 });
    const now = MAIL_LIMITS.undeliveredMs * 10;
    expect(decideHandover(done)).toBe("hand");
    expect(decideDelivery(briefing, done, now)).toEqual({
      kind: "hold",
      reason: "labelled-only",
    });
  });

  it("no longer refuses a message for its age, on either path", () => {
    // Age used to destroy: a message older than the window was dropped and
    // its sender told it never arrived, so a teammate running a long build
    // lost everything written to it. Whether stale content is still worth
    // acting on is the RECEIVER's judgement — the deck does not know what
    // the message says — and its sender is told it is waiting instead.
    const old = mail({ at: 0 });
    const now = MAIL_LIMITS.undeliveredMs * 10;
    expect(decideHandover(done)).toBe("hand");
    expect(decideDelivery(old, done, now)).toEqual({ kind: "deliver" });
    expect(isOverdue(old, now)).toBe(true);
  });

  it("keeps no clock at all on a briefing", () => {
    // An agent that takes no turn for an hour is exactly the one that would
    // otherwise be told its briefing is overdue, when the briefing is what
    // it is missing.
    const briefing = mail({ kind: "team", at: 0 });
    expect(isOverdue(briefing, MAIL_LIMITS.undeliveredMs * 100)).toBe(false);
  });
});

describe("decideSend", () => {
  it("opens a chain at hop zero when nothing woke the sender", () => {
    expect(decideSend(sender, "pane-2", null)).toEqual({ kind: "accept", hop: 0 });
  });

  it("continues a chain one hop past the message that woke the sender", () => {
    expect(decideSend(sender, "pane-2", 3)).toEqual({ kind: "accept", hop: 4 });
  });

  it("lets only the lead hand out work on a team", () => {
    // The rule that makes "lead" mean something rather than describe
    // something. Told but unenforced, the hierarchy lasts exactly until the
    // first agent decides it disagrees.
    const lead = { ...sender, role: "lead" };
    const impl = { ...sender, role: "impl-1" };
    expect(decideSend(lead, "pane-2", null, MAIL_LIMITS, "task")).toEqual({
      kind: "accept",
      hop: 0,
    });
    expect(decideSend(impl, "pane-2", null, MAIL_LIMITS, "task")).toEqual({
      kind: "refuse",
      refusal: "not-yours-to-assign",
    });
    // Everything else it may say to anyone: a member that can only be
    // spoken to is not a member, and reporting back is the whole point.
    for (const kind of ["question", "answer", "note"] as const) {
      expect(decideSend(impl, "pane-2", null, MAIL_LIMITS, kind), kind).toEqual({
        kind: "accept",
        hop: 0,
      });
    }
  });

  it("leaves a pane on no team exactly as it was before teams existed", () => {
    // No team is no hierarchy. Restricting a sender that answers to nobody
    // would take away a capability to enforce a structure it is not in.
    expect(decideSend(sender, "pane-2", null, MAIL_LIMITS, "task")).toEqual({
      kind: "accept",
      hop: 0,
    });
  });

  it("refuses a pane mailing itself — a loop of one, and it never ends", () => {
    expect(decideSend(sender, sender.paneId, null)).toEqual({
      kind: "refuse",
      refusal: "self-addressed",
    });
  });

  it("stops the chain one hop past the limit, and not before", () => {
    // The boundary IS the guard: off by one here and either a legitimate
    // exchange is cut short or an A↔B loop runs a turn longer than agreed,
    // and every extra turn is money.
    expect(decideSend(sender, "pane-2", MAIL_LIMITS.maxHops - 1)).toEqual({
      kind: "accept",
      hop: MAIL_LIMITS.maxHops,
    });
    expect(decideSend(sender, "pane-2", MAIL_LIMITS.maxHops)).toEqual({
      kind: "refuse",
      refusal: "hop-limit",
    });
  });

  it("refuses a self-send even when the chain still has budget", () => {
    // Order matters: the cheaper, unconditional refusal must not hide
    // behind the hop check, or a self-addressed message would be accepted
    // for eight hops before anything objected.
    expect(decideSend(sender, sender.paneId, 0)).toEqual({
      kind: "refuse",
      refusal: "self-addressed",
    });
  });
});

describe("the reports owed to a sender", () => {
  it("tells a sender its message is waiting, and that nothing was lost", () => {
    const notice = overdueNotice(mail({ kind: "task", hop: 2 }), "mail-9", 5_000);
    expect(notice).toMatchObject({
      id: "mail-9",
      kind: "undelivered",
      from: { kind: "host" },
      toPaneId: sender.paneId,
      replyTo: "mail-1",
      at: 5_000,
    });
    expect(notice?.body).toContain("task");
    // The distinction the whole change turns on: a sender that reads
    // "dropped" re-sends, and a lead already did exactly that off a weaker
    // signal — it read `delivered: false` as failure and went looking for
    // whether its teammates were alive.
    expect(notice?.body).toContain("nothing to re-send");
  });

  it("says plainly when a message really was lost", () => {
    // The one way that still happens, and it is about a queue with no end in
    // sight rather than about a clock.
    expect(droppedNotice(mail({ kind: "task" }), "mail-9", 5_000)?.body).toContain(
      "Dropped",
    );
  });

  it("copies the hop instead of advancing it", () => {
    // A report is the mail system accounting for itself. Advancing the
    // counter would spend the sender's chain budget on news it never asked
    // for, and could refuse the reply it is about to want to send.
    expect(overdueNotice(mail({ hop: 4 }), "mail-9", 5_000)?.hop).toBe(4);
    expect(droppedNotice(mail({ hop: 4 }), "mail-9", 5_000)?.hop).toBe(4);
  });

  it("owes nothing for a report about a report", () => {
    // Otherwise every undelivered notice mints another one, forever, and
    // the hop counter cannot stop it because the hop never advances.
    expect(overdueNotice(mail({ kind: "undelivered" }), "mail-9", 5_000)).toBeNull();
    expect(droppedNotice(mail({ kind: "undelivered" }), "mail-9", 5_000)).toBeNull();
  });

  it("owes nothing when the host was the sender", () => {
    expect(overdueNotice(mail({ from: { kind: "host" } }), "mail-9", 5_000)).toBeNull();
    expect(droppedNotice(mail({ from: { kind: "host" } }), "mail-9", 5_000)).toBeNull();
  });
});
