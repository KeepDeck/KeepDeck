import { describe, expect, it, vi } from "vitest";
import type { MailReplyRenderer } from "@keepdeck/plugin-api";
import { log } from "../../ipc/log";
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
    /** The answer reaches nobody — the hook timed out, or its process died. */
    lost?: boolean;
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
    reply: (paneId: string, id: string, body: string) => {
      replies.push({ paneId, id, body });
      // Delivered unless a test says otherwise: the transport answers this,
      // and answering it is what replaced the memory that used to guess.
      return Promise.resolve(options.lost !== true);
    },
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

  it("treats an empty rendering as no rendering at all", () => {
    // The transport arms its collection watchdog only for an answer WITH
    // content, because an empty one carries nothing to lose. So handing
    // messages over and then writing "" books them against a reply nobody
    // watches: they age out of the hand-over memory in thirty seconds with
    // every sender told they were delivered. Nothing in tree returns "" —
    // it takes one third-party renderer, which is the whole point of a
    // contract having a stated behaviour for it.
    const h = setup({ render: () => "" });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    h.channel.answer("pane-2", asking());

    expect(h.replies).toEqual([{ paneId: "pane-2", id: "askABC", body: "" }]);
    // Back in the queue, not booked against an unwatched reply.
    expect(h.manager.takeAtTurnEnd("pane-2").map((mail) => mail.body)).toEqual([
      "careful",
    ]);
  });

  it("puts back a message nobody rendered, to be given out exactly once more", () => {
    // Withdrawing the journal entry is what makes that possible: booked as
    // delivered, it would be a message the agent was never handed and can
    // never be handed again.
    const h = setup({ render: () => null });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "note", body: "careful" });
    h.channel.answer("pane-2", asking());
    expect(h.manager.inbox("pane-2").messages.map((mail) => mail.body)).toEqual(["careful"]);
    expect(h.manager.inbox("pane-2").messages).toEqual([]);
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

  it("refuses to hand anything over on a correlation the transport cannot answer", () => {
    // The correlation is the AGENT's word. This side accepted any non-empty
    // string while the transport accepted only a filename-safe one, so an ask
    // carrying a space made the deck empty the pane's queue, render it, and
    // hand it to a write that refused — no file, no watchdog, no report, and
    // the messages aged out of the hand-over memory with every sender told
    // they had been delivered. Repeatable by whatever runs in that pane.
    //
    // An unanswerable correlation now reads as "this envelope reports and
    // asks nothing": nothing is taken, and nothing is written back.
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    for (const hostile of ["a b", "../escape", "", "x".repeat(65), "ask\0"]) {
      h.channel.answer("pane-2", asking({ reply: hostile }));
    }
    expect(h.replies).toEqual([]);
    // Still waiting, for an ask that can actually be answered.
    expect(h.manager.takeAtTurnEnd("pane-2")).toHaveLength(1);
  });

  it("keeps an agent's own words out of the log line about it", () => {
    // The event name comes out of an envelope, so it is whatever the pane's
    // process wrote. A newline in it forges a second log entry — the one
    // window onto this channel, and the pane can write in it.
    const h = setup();
    const lines: string[] = [];
    const spy = vi
      .spyOn(log, "info")
      .mockImplementation((_scope, message) => lines.push(message));
    h.channel.answer(
      "pane-2",
      asking({ event: { hook_event_name: "Stop\n[web:mail] pane-9 asked on Stop" } }),
    );
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).toContain("an unreadable event");
  });

  it("puts the messages back when the answer reached nobody", () => {
    // The messages left the queue to travel in that answer. If it reaches
    // nobody — the hook timed out, the process died — they are gone and
    // nobody is told. The transport used to guess at this by waiting out a
    // window; it now says so, and this is what the deck does about it.
    const h = setup({ lost: true });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    h.channel.answer("pane-2", asking());
    expect(h.replies).toHaveLength(1);

    return Promise.resolve().then(() => {
      const back = h.manager.takeAtTurnEnd("pane-2");
      expect(back.map((mail) => mail.body)).toEqual(["take the parser"]);
    });
  });

  it("keeps the messages taken when the answer landed", () => {
    // The other half, and the one that must NOT put anything back: a
    // delivered answer means the hook has them.
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    h.channel.answer("pane-2", asking());

    return Promise.resolve().then(() => {
      expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);
    });
  });

  it("puts messages back into the queue they came from, not into a later one", () => {
    // The answer resolves a moment after the hand-over, and the feature can
    // be switched off in between — which destroys the queues. Restoring into
    // whatever manager is live NOW would put messages into a fresh queue the
    // user had deliberately cleared.
    const h = setup({ lost: true });
    const replaced = createMailManager({
      activityOf: () => WORKING,
      subscribeActivity: () => () => {},
      subscribeChannels: () => () => {},
      deliver: () => true,
      wake: () => true,
      asksAtTurnEnd: () => true,
      now: () => 1_000,
      schedule: () => () => {},
    });
    let live: MailManager = h.manager;
    const channel = createHookReplies({ ...h.deps, mail: () => live });

    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    channel.answer("pane-2", asking());
    live = replaced; // the toggle went off and on again

    return Promise.resolve().then(() => {
      expect(replaced.takeAtTurnEnd("pane-2")).toEqual([]);
    });
  });
});
