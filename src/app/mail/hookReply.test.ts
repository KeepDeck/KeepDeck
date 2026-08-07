import { describe, expect, it } from "vitest";
import type { MailReplyRenderer } from "@keepdeck/plugin-api";
import type { Mail, MailSender } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { answerMailAsk } from "./hookReply";
import { createMailManager, type MailManager } from "./mailManager";

const A: MailSender = { paneId: "pane-1", workspaceId: "ws-1", label: "Agent 1" };
const WORKING: PaneActivity = { state: "working", since: 1 };

const RENDER: MailReplyRenderer = ({ messages }) =>
  JSON.stringify({ decision: "block", reason: messages.map((m) => m.body).join("|") });

function setup(options: { render?: MailReplyRenderer | undefined; off?: boolean } = {}) {
  const pasted: Mail[] = [];
  const manager: MailManager = createMailManager({
    activityOf: () => WORKING,
    subscribeActivity: () => () => {},
    subscribeChannels: () => () => {},
    deliver: (mail) => {
      pasted.push(mail);
      return true;
    },
    asksAtTurnEnd: () => true,
    now: () => 1_000,
    schedule: () => () => {},
  });
  const replies: { id: string; body: string }[] = [];
  const deps = {
    mail: () => (options.off ? null : manager),
    rendererFor: () => ("render" in options ? options.render : RENDER),
    reply: (id: string, body: string) => replies.push({ id, body }),
  };
  return { manager, replies, pasted, deps };
}

function asking(extra: Record<string, unknown> = {}) {
  return {
    agent: "claude",
    reply: "askABC",
    event: { hook_event_name: "Stop" },
    ...extra,
  };
}

describe("answerMailAsk", () => {
  it("hands over what is waiting, rendered by the agent's own plugin", () => {
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    // Held rather than pasted: a running turn is worth waiting out.
    expect(h.pasted).toHaveLength(0);

    answerMailAsk(h.deps, "pane-2", asking());
    expect(h.replies).toEqual([
      { id: "askABC", body: JSON.stringify({ decision: "block", reason: "take the parser" }) },
    ]);
    // Booked, so the terminal cannot deliver it a second time.
    expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("answers with nothing rather than leaving the hook to time out", () => {
    // The common case by far. A hook that gets no file waits out its whole
    // timeout, and paying that on every turn end would tax every pane for
    // the sake of the rare one with mail.
    const h = setup();
    answerMailAsk(h.deps, "pane-2", asking());
    expect(h.replies).toEqual([{ id: "askABC", body: "" }]);
  });

  it("says nothing at all to a report that asked nothing", () => {
    const h = setup();
    answerMailAsk(h.deps, "pane-2", { agent: "claude", event: { hook_event_name: "Stop" } });
    expect(h.replies).toEqual([]);
  });

  it("gives mail back when the event cannot carry it after all", () => {
    // An armed event whose renderer declines — the message must survive to
    // be handed over at an event that can, or through the terminal behind
    // that.
    const h = setup({ render: () => null });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    answerMailAsk(h.deps, "pane-2", asking());
    expect(h.replies).toEqual([{ id: "askABC", body: "" }]);
    const back = h.manager.takeAtTurnEnd("pane-2");
    expect(back.map((mail) => mail.body)).toEqual(["careful"]);
  });

  it("withdraws the inbox entry along with the message it gives back", () => {
    // Otherwise a catch-up read would show a message the agent was never
    // handed.
    const h = setup({ render: () => null });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    answerMailAsk(h.deps, "pane-2", asking());
    expect(h.manager.inbox("pane-2")).toEqual([]);
  });

  it("answers nothing when the feature is switched off mid-flight", () => {
    // The toggle can flip between two hook invocations, and a hook already
    // waiting still deserves an answer.
    const h = setup({ off: true });
    answerMailAsk(h.deps, "pane-2", asking());
    expect(h.replies).toEqual([{ id: "askABC", body: "" }]);
  });

  it("answers nothing when the agent's plugin renders no mail", () => {
    const h = setup({ render: undefined });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    answerMailAsk(h.deps, "pane-2", asking());
    expect(h.replies).toEqual([{ id: "askABC", body: "" }]);
    // And the message is untouched, still waiting for the terminal.
    expect(h.manager.takeAtTurnEnd("pane-2")).toHaveLength(1);
  });
});
