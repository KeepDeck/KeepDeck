import { describe, expect, it } from "vitest";
import type { PaneActivity } from "../status";
import type { Mail, MailSender } from "./message";
import { MAIL_LIMITS, decideDelivery, decideSend, expiryNotice } from "./policy";

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
    // ...and having a hook does not change it either: the hook takes mail
    // out of the queue without consulting this, so "hold" IS "the labelled
    // channel or nothing".
    expect(decideDelivery(briefing, done, SENT_AT, MAIL_LIMITS, true)).toEqual({
      kind: "hold",
      reason: "labelled-only",
    });
    // Expiry still outranks it — a briefing nobody came for is dropped
    // rather than held forever.
    expect(
      decideDelivery(briefing, done, SENT_AT + MAIL_LIMITS.undeliveredMs),
    ).toEqual({ kind: "expire" });
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

  it("expiry outranks EVERY other verdict, holds included", () => {
    // The ordering rule, and the one a refactor quietly loses: move the
    // clock check below the holds and a message can sit at a permission
    // prompt forever, then land the moment the user clicks — a correction
    // arriving after the action it meant to stop. Never is better than
    // late, because never can be reported back to the sender.
    //
    // Every state is asserted here on purpose: the held ones are what pin
    // the ORDER (they are the verdicts expiry has to beat), the reachable
    // ones pin that an aged message is not delivered just because it could
    // have been.
    const late = SENT_AT + MAIL_LIMITS.undeliveredMs;
    for (const activity of [working, asking, done, failed, approving, undefined]) {
      expect(decideDelivery(mail(), activity, late)).toEqual({ kind: "expire" });
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

  it("gives up waiting and uses the terminal rather than losing the message", () => {
    // A turn can run far longer than a course correction stays useful.
    // Late-but-labelled is worth a short wait; never-because-we-waited is
    // not.
    const spent = SENT_AT + MAIL_LIMITS.hookWaitMs;
    expect(decideDelivery(mail(), working, spent, MAIL_LIMITS, true)).toEqual({
      kind: "deliver",
    });
  });

  it("waits for the labelled channel whatever the pane is doing", () => {
    // This used to wait only on a RUNNING pane, which made the terminal the
    // normal path rather than the exception: an idle pane reports `done`, so
    // the good channel was skipped for exactly the messages with time to use
    // it. The terminal is not merely unlabelled, it is unreliable — its
    // submit is a separate keystroke that a pane can fail to take, leaving
    // the message in the composer and the deck none the wiser.
    for (const activity of [working, done, failed, asking, undefined]) {
      expect(
        decideDelivery(mail(), activity, SENT_AT, MAIL_LIMITS, true),
        String(activity?.state),
      ).toEqual({ kind: "hold", reason: "turn-boundary" });
    }
    // ...and a permission prompt outranks it, hook or not.
    expect(decideDelivery(mail(), approving, SENT_AT, MAIL_LIMITS, true)).toEqual({
      kind: "hold",
      reason: "permission",
    });
  });

  it("falls back to the terminal once the wait for a hook is spent", () => {
    // The bound is what keeps the preference from becoming a trap: an agent
    // that never takes another turn would otherwise hold its mail until it
    // expired, and the message would reach nobody at all.
    const late = SENT_AT + MAIL_LIMITS.hookWaitMs;
    expect(decideDelivery(mail(), done, late, MAIL_LIMITS, true)).toEqual({
      kind: "deliver",
    });
    // And the wait is strictly shorter than the life of the message, or the
    // fallback would never get a turn.
    expect(MAIL_LIMITS.hookWaitMs).toBeLessThan(MAIL_LIMITS.undeliveredMs);
  });

  it("steers straight into a running turn when no hook exists", () => {
    // The pre-existing behaviour, and what every CLI without a mail-capable
    // hook still gets.
    expect(decideDelivery(mail(), working, SENT_AT, MAIL_LIMITS, false)).toEqual({
      kind: "deliver",
    });
  });

  it("reads the limits it is given, not only the shipped ones", () => {
    // Guards against the bound being read from the module constant instead
    // of the argument — a bug no default-limits test can see.
    const limits = { undeliveredMs: 10, maxHops: 1, hookWaitMs: 5 };
    expect(decideDelivery(mail(), working, SENT_AT + 10, limits)).toEqual({ kind: "expire" });
    expect(decideDelivery(mail(), working, SENT_AT + 9, limits)).toEqual({ kind: "deliver" });
  });
});

describe("decideSend", () => {
  it("opens a chain at hop zero when nothing woke the sender", () => {
    expect(decideSend(sender, "pane-2", null)).toEqual({ kind: "accept", hop: 0 });
  });

  it("continues a chain one hop past the message that woke the sender", () => {
    expect(decideSend(sender, "pane-2", 3)).toEqual({ kind: "accept", hop: 4 });
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

describe("expiryNotice", () => {
  it("reports back to the pane that sent the expired message", () => {
    const notice = expiryNotice(mail({ kind: "task", hop: 2 }), "mail-9", 5_000);
    expect(notice).toMatchObject({
      id: "mail-9",
      kind: "undelivered",
      from: { kind: "host" },
      toPaneId: sender.paneId,
      replyTo: "mail-1",
      at: 5_000,
    });
    expect(notice?.body).toContain("task");
  });

  it("copies the hop instead of advancing it", () => {
    // A report is the mail system accounting for itself. Advancing the
    // counter would spend the sender's chain budget on news it never asked
    // for, and could refuse the reply it is about to want to send.
    expect(expiryNotice(mail({ hop: 4 }), "mail-9", 5_000)?.hop).toBe(4);
  });

  it("owes nothing for a report that itself expired", () => {
    // Otherwise every undelivered notice mints another one, forever, and
    // the hop counter cannot stop it because the hop never advances.
    expect(expiryNotice(mail({ kind: "undelivered" }), "mail-9", 5_000)).toBeNull();
  });

  it("owes nothing when the host was the sender", () => {
    expect(
      expiryNotice(mail({ from: { kind: "host" } }), "mail-9", 5_000),
    ).toBeNull();
  });
});
