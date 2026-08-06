import { describe, expect, it } from "vitest";
import type { PaneActivity } from "../status";
import type { Mail, MailSender } from "./message";
import { MAIL_LIMITS, decideDelivery, decideSend } from "./policy";

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
    from: sender,
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

  it("holds at a permission prompt — the one state where text answers a menu", () => {
    expect(decideDelivery(mail(), approving, SENT_AT)).toEqual({
      kind: "hold",
      reason: "permission",
    });
  });

  it("holds while nothing reports for the pane — starting and suspended look alike", () => {
    expect(decideDelivery(mail(), undefined, SENT_AT)).toEqual({
      kind: "hold",
      reason: "not-reporting",
    });
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

  it("reads the limits it is given, not only the shipped ones", () => {
    // Guards against the bound being read from the module constant instead
    // of the argument — a bug no default-limits test can see.
    const limits = { undeliveredMs: 10, maxHops: 1 };
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
