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

  it("refuses a second ask while an answer is still awaiting collection", () => {
    // The second answer REPLACES the first file. The common second answer is
    // EMPTY — nothing waiting — and the transport arms no collection watchdog
    // for an empty one, because an empty one carries nothing to lose. So a
    // reporter reusing a correlation could overwrite a reply full of messages
    // with a blank, and those messages would sit booked, unwatched, and be
    // gone in thirty seconds with their senders told they were delivered.
    //
    // Both shipped reporters mint a fresh id per ask, so this needs a
    // modified one — which is exactly the threat this channel is written for.
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "first" });
    h.channel.answer("pane-2", asking());
    expect(h.replies).toHaveLength(1);

    h.channel.answer("pane-2", asking());
    // Nothing written over the outstanding answer.
    expect(h.replies).toHaveLength(1);
    // And the first ask's messages are still recoverable.
    h.channel.uncollected("pane-2", "askABC");
    expect(h.manager.takeAtTurnEnd("pane-2").map((mail) => mail.body)).toEqual([
      "first",
    ]);
  });

  it("answers again on a correlation whose answer was already reported unread", () => {
    // The other side of the same rule: once the transport says nobody came
    // for an answer, that correlation is free. A hook that retries after its
    // own timeout must not be stonewalled — the messages are back in the
    // queue and this is the ask that carries them.
    const h = setup();
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "first" });
    h.channel.answer("pane-2", asking());
    h.channel.uncollected("pane-2", "askABC");

    h.channel.answer("pane-2", asking());
    expect(h.replies).toHaveLength(2);
    expect(h.replies[1].body).toContain("first");
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

  it("puts messages back into the queue they came from, not into a later one", () => {
    // The report arrives seconds after the hand-over, and the feature can be
    // switched off in between — which destroys the queues. Restoring into
    // whatever manager is live NOW would take mail out of a queue the user
    // cleared and put it into a fresh one, delivering messages that were
    // deliberately thrown away.
    const h = setup();
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

    channel.uncollected("pane-2", "askABC");
    expect(replaced.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("forgets every hand-over when the queues behind them are destroyed", () => {
    // `forgetAll` is what the owner calls as it disposes a manager. Without
    // it the memory outlives what it describes, and its timers outlive the
    // service.
    const h = setup();
    let cancelled = 0;
    const channel = createHookReplies({
      ...h.deps,
      schedule: () => () => {
        cancelled += 1;
      },
    });
    h.manager.send({ from: A, toPaneId: "pane-2", kind: "task", body: "take the parser" });
    channel.answer("pane-2", asking());

    channel.forgetAll();
    expect(cancelled).toBe(1);
    channel.uncollected("pane-2", "askABC");
    expect(h.manager.takeAtTurnEnd("pane-2")).toEqual([]);
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
