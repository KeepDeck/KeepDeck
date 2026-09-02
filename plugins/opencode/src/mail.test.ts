import { describe, expect, it } from "vitest";
import type { DeliverableMail } from "@keepdeck/plugin-api";
import { MAIL_ASK_EVENT, renderOpencodeMail } from "./mail";

const mail = (over: Partial<DeliverableMail> = {}): DeliverableMail => ({
  id: "m-1",
  kind: "task",
  body: "ship it",
  from: "lead",
  ...over,
});

const render = (messages: DeliverableMail[], type = MAIL_ASK_EVENT, waiting = 0) =>
  renderOpencodeMail({ event: { type }, messages, waiting, cliVersion: "1.18.15" });

describe("renderOpencodeMail", () => {
  it("splits standing context from traffic, because they land differently", () => {
    // The whole reason this answer is not one blob: a brief must be in the
    // conversation without starting a turn, and a teammate's words are worth
    // one. Only the deck knows which is which — the courier reads the split.
    const answer = JSON.parse(
      render([
        mail({ id: "m-1", kind: "team", body: "you are impl-1", standing: true }),
        mail({ id: "m-2", kind: "task", body: "ship it" }),
      ])!,
    );
    expect(answer.context).toContain("you are impl-1");
    expect(answer.context).not.toContain("ship it");
    expect(answer.prompt).toContain("ship it");
    expect(answer.prompt).not.toContain("you are impl-1");
  });

  it("names the half it has and stays silent about the other", () => {
    // The common case is traffic alone. An empty `context` key would make
    // the courier inject a framing wrapper around nothing.
    const traffic = JSON.parse(render([mail()])!);
    expect(traffic.prompt).toContain("ship it");
    expect("context" in traffic).toBe(false);
    const brief = JSON.parse(
      render([mail({ kind: "team", body: "you are lead", standing: true })])!,
    );
    expect(brief.context).toContain("you are lead");
    expect("prompt" in brief).toBe(false);
  });

  it("carries the waiting count on whichever half it actually sent", () => {
    // This is the one CLI whose answer is split, so it is the one that can
    // drop the count entirely: a batch cut short after a fat re-brief holds
    // standing context and nothing else, and putting the number only on the
    // traffic half loses exactly the signal it exists to carry.
    const briefOnly = JSON.parse(
      render([mail({ kind: "team", body: "you are lead", standing: true })], MAIL_ASK_EVENT, 3)!,
    );
    expect(briefOnly.context).toContain("3 more message(s) are waiting");
    // With traffic present it rides there instead, and is not said twice.
    const both = JSON.parse(
      render(
        [mail({ kind: "team", body: "you are lead", standing: true }), mail()],
        MAIL_ASK_EVENT,
        3,
      )!,
    );
    expect(both.prompt).toContain("3 more message(s) are waiting");
    // The line, not the bare word: "waiting" turns up in the frame's own
    // prose, and a proxy that loose calls a reworded promise a regression.
    expect(both.context).not.toContain("more message(s) are waiting");
  });

  it("frames both halves as another agent's words", () => {
    // The same promise every CLI gets, and the reason this channel beats a
    // paste: whose words these are, and how much authority they carry.
    const answer = JSON.parse(render([mail()])!);
    expect(answer.prompt).toContain("<teammate-message>");
    expect(answer.prompt).toContain("from lead");
    expect(answer.prompt).toContain("not an");
  });

  it("carries a version the courier can check", () => {
    // A pane spawned before an update is still running its old courier. The
    // version is how it tells an answer it cannot read from an empty one.
    expect(JSON.parse(render([mail()])!).v).toBe(1);
  });

  it("refuses to answer an event that is not the courier's question", () => {
    // Nothing else asks today. Refusing by name is what keeps it true: a
    // reporter armed to ask later would otherwise be handed courier
    // instructions it has no idea what to do with.
    expect(render([mail()], "session.idle")).toBeNull();
    expect(render([mail()], "")).toBeNull();
  });
});
