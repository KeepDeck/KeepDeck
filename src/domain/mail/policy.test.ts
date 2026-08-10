import { describe, expect, it } from "vitest";
import type { PaneActivity } from "../status";
import type { Mail, MailSender } from "./message";
import {
  MAIL_LIMITS,
  decideDelivery,
  decideHandover,
  decideSend,
  expiryNotice,
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
    // Traffic still keeps it: acting late can be worse than not acting.
    expect(
      decideDelivery(mail(), done, SENT_AT + MAIL_LIMITS.undeliveredMs),
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
    const limits = {
      undeliveredMs: 10,
      maxHops: 1,
      hookWaitMs: 5,
      handoverChars: 100,
    };
    expect(decideDelivery(mail(), working, SENT_AT + 10, limits)).toEqual({ kind: "expire" });
    expect(decideDelivery(mail(), working, SENT_AT + 9, limits)).toEqual({ kind: "deliver" });
  });
});

describe("decideHandover", () => {
  it("shares its clauses with the terminal's verdict rather than copying them", () => {
    // The point of the function: one answer to "is this still worth landing"
    // and one to "is this pane safe to push at", used by both channels. They
    // were copied into the application owner once, and a fifth reason to
    // hold would then have been honoured on the terminal path and ignored on
    // the labelled one — the path a briefing exclusively uses.
    const stale = mail({ at: 0 });
    const now = MAIL_LIMITS.undeliveredMs;
    expect(decideHandover(stale, undefined, now)).toBe("expire");
    expect(decideDelivery(stale, undefined, now)).toEqual({ kind: "expire" });

    const fresh = mail({ at: now });
    expect(decideHandover(fresh, approving, now)).toBe("hold");
    expect(decideDelivery(fresh, approving, now)).toEqual({
      kind: "hold",
      reason: "permission",
    });
  });

  it("hands over the standing context the other channel refuses to touch", () => {
    // The one place the two verdicts MUST differ: a briefing is held from the
    // terminal forever and delivered here, because this is the moment it was
    // waiting for.
    const briefing = mail({ kind: "team", at: 0 });
    const now = MAIL_LIMITS.undeliveredMs * 10;
    expect(decideHandover(briefing, done, now)).toBe("hand");
    expect(decideDelivery(briefing, done, now)).toEqual({
      kind: "hold",
      reason: "labelled-only",
    });
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
