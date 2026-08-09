import { describe, expect, it } from "vitest";
import type { MailReplyRenderer } from "@keepdeck/plugin-api";
import type { Mail, MailSender } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createHookReplies } from "./hookReply";
import { createMailManager, type MailManager } from "./mailManager";

const A: MailSender = { paneId: "pane-1", workspaceId: "ws-1", label: "Agent 1" };
const WORKING: PaneActivity = { state: "working", since: 1 };

/**
 * A renderer that puts the WHOLE `DeliverableMail` in its output, not just
 * the body.
 *
 * Deliberate: this fake stands in for every CLI plugin, and the host→plugin
 * mapping (`standing`, `from` as the role rather than the pane's title,
 * `replyTo`) is exactly the kind of field a body-only fake leaves unasserted
 * — which is how a delivery that silently dropped every message once passed
 * a full green suite.
 */
const RENDER: MailReplyRenderer = ({ messages }) =>
  JSON.stringify({
    decision: "block",
    reason: messages
      .map(
        (m) =>
          `${m.id}/${m.kind}/${m.from}/${m.standing ? "standing" : "traffic"}${
            m.replyTo ? `/re:${m.replyTo}` : ""
          }: ${m.body}`,
      )
      .join("|"),
  });

function setup(
  options: {
    render?: MailReplyRenderer | undefined;
    off?: boolean;
    cliVersion?: string;
  } = {},
) {
  const pasted: Mail[] = [];
  const manager: MailManager = createMailManager({
    activityOf: () => WORKING,
    subscribeActivity: () => () => {},
    subscribeChannels: () => () => {},
    deliver: (mail) => {
      pasted.push(mail);
      return true;
    },
    wake: () => true,
    asksAtTurnEnd: () => true,
    now: () => 1_000,
    schedule: () => () => {},
  });
  const replies: { paneId: string; id: string; body: string }[] = [];
  const deps = {
    mail: () => (options.off ? null : manager),
    rendererFor: () => ("render" in options ? options.render : RENDER),
    versionOf: () => options.cliVersion ?? null,
    reply: (paneId: string, id: string, body: string) =>
      replies.push({ paneId, id, body }),
    // No clock: the hand-over memory ages out on a timer these tests never
    // need to run, and a real setTimeout would keep the suite awake.
    schedule: () => () => {},
  };
  const channel = createHookReplies(deps);
  return { manager, replies, pasted, deps, channel };
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

    h.channel.answer("pane-2", asking());
    // The whole mapping, not just the body: the sender arrives as a name the
    // receiver can reply TO, and a message is marked standing or traffic by
    // the host so no plugin re-derives it from `kind`.
    expect(h.replies).toEqual([
      {
        paneId: "pane-2",
        id: "askABC",
        body: JSON.stringify({
          decision: "block",
          reason: "mail-1/task/Agent 1/traffic: take the parser",
        }),
      },
    ]);
    // Booked, so the terminal cannot deliver it a second time.
    expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("answers with nothing rather than leaving the hook to time out", () => {
    // The common case by far. A hook that gets no file waits out its whole
    // timeout, and paying that on every turn end would tax every pane for
    // the sake of the rare one with mail.
    const h = setup();
    h.channel.answer("pane-2",asking());
    expect(h.replies).toEqual([
      { paneId: "pane-2", id: "askABC", body: "" },
    ]);
  });

  it("says nothing at all to a report that asked nothing", () => {
    const h = setup();
    h.channel.answer("pane-2",{ agent: "claude", event: { hook_event_name: "Stop" } });
    expect(h.replies).toEqual([]);
  });

  it("gives mail back when the event cannot carry it after all", () => {
    // An armed event whose renderer declines — the message must survive to
    // be handed over at an event that can, or through the terminal behind
    // that.
    const h = setup({ render: () => null });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    h.channel.answer("pane-2",asking());
    expect(h.replies).toEqual([
      { paneId: "pane-2", id: "askABC", body: "" },
    ]);
    const back = h.manager.takeAtTurnEnd("pane-2");
    expect(back.map((mail) => mail.body)).toEqual(["careful"]);
  });

  it("withdraws the inbox entry along with the message it gives back", () => {
    // Otherwise a catch-up read would show a message the agent was never
    // handed.
    const h = setup({ render: () => null });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    h.channel.answer("pane-2",asking());
    expect(h.manager.inbox("pane-2")).toEqual([]);
  });

  it("answers nothing when the feature is switched off mid-flight", () => {
    // The toggle can flip between two hook invocations, and a hook already
    // waiting still deserves an answer.
    const h = setup({ off: true });
    h.channel.answer("pane-2",asking());
    expect(h.replies).toEqual([
      { paneId: "pane-2", id: "askABC", body: "" },
    ]);
  });

  it("answers nothing when the agent's plugin renders no mail", () => {
    const h = setup({ render: undefined });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    h.channel.answer("pane-2",asking());
    expect(h.replies).toEqual([
      { paneId: "pane-2", id: "askABC", body: "" },
    ]);
    // And the message is untouched, still waiting for the terminal.
    expect(h.manager.takeAtTurnEnd("pane-2")).toHaveLength(1);
  });

  it("puts the messages back when nobody read the answer", () => {
    // The messages left the queue to be written into a file. If that file is
    // never opened — the hook timed out, the process died, something removed
    // it — they are gone and nobody is told. This is the only path that can
    // undo that, and the transport is the only thing that can see it happen.
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    h.channel.answer("pane-2", asking());
    expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);

    h.channel.uncollected("pane-2", "askABC");
    const back = h.manager.takeAtTurnEnd("pane-2");
    expect(back.map((mail) => mail.body)).toEqual(["take the parser"]);
  });

  it("will not let one pane reclaim another's hand-over", () => {
    // The correlation comes out of an envelope, so it is the sender's word.
    // Remembering the PAIR is what stops a pane naming somebody else's
    // correlation and pulling their messages back into its own queue.
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    h.channel.answer("pane-2", asking());

    h.channel.uncollected("pane-3", "askABC");
    expect(h.manager.takeAtTurnEnd("pane-3")).toEqual([]);
    expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);
    // And the rightful owner can still get them back afterwards.
    h.channel.uncollected("pane-2", "askABC");
    expect(h.manager.takeAtTurnEnd("pane-2")).toHaveLength(1);
  });

  it("forgets a hand-over nobody reported, so the map cannot grow forever", () => {
    // Success is never confirmed — the transport reports only failure — so
    // the memory has to age out on its own.
    let expire: (() => void) | null = null;
    const h = setup();
    const channel = createHookReplies({
      ...h.deps,
      schedule: (fn) => {
        expire = fn;
        return () => {};
      },
    });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    channel.answer("pane-2", asking());
    expire!();

    channel.uncollected("pane-2", "askABC");
    expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);
  });
});
