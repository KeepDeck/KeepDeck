import { describe, expect, it } from "vitest";
// The Mod exactly as claude loads it — plain JS beside its copy of the wire.
import { register } from "../resources/keepdeck-mod/hooks/register.js";
import { MOD_INTERRUPT_EVENT, MOD_PROMPT_ACCEPTED_EVENT } from "./status";
import { present, recordOf, stringOf } from "@keepdeck/plugin-api/testing";

const BRIDGE = JSON.stringify({
  v: 2,
  dir: "/run/p-1",
  pane: "p-1",
  token: "secret",
  url: "http://127.0.0.1:9/envelope",
});

type Handler = Parameters<Parameters<typeof register>[0]>[1];

/** The Mod registered against a fake claude: its handlers by event, and a
 * `$` whose env, process and HTTP the test controls. */
function loaded({
  bridge = BRIDGE as string | null,
  pgid = "4021\n",
  status = 204,
} = {}) {
  const handlers = new Map<string, Handler>();
  register((name: string, handler: Handler) => handlers.set(name, handler));
  const posted: { url: string; envelope: { type: string; payload: Record<string, unknown> } }[] = [];
  /** The doorbell as a file the test raises; the timer the Mod set. */
  const doorbell = { up: false, removed: 0 };
  const timers: { ms: number; tick: () => Promise<void> }[] = [];
  const submitted: string[] = [];
  let submitAnswer: unknown = { text: "ok" };
  const $ = {
    clock: {
      every: (ms: number, tick: () => Promise<void>) => {
        timers.push({ ms, tick });
        return { cancel() {} };
      },
    },
    fs: { exists: async (path: string) => path === "/run/p-1/mail.wake" && doorbell.up },
    prompt: {
      submit: async ({ text }: { text: string }) => {
        submitted.push(text);
        if (submitAnswer instanceof Error) throw submitAnswer;
        return submitAnswer;
      },
    },
    env: {
      get: async (name: string) => (name === "KEEPDECK_BRIDGE" ? (bridge ?? undefined) : undefined),
    },
    process: {
      run: async (argv: string[]) => {
        if (argv[0] === "/bin/sh" && argv[2]?.startsWith("mv ")) {
          expect(argv.slice(3)).toEqual(["sh", "/run/p-1/mail.wake"]);
          // A rename: only the first taker finds the file.
          if (!doorbell.up) return { exitCode: 1, stdout: "", stderr: "No such file" };
          doorbell.up = false;
          doorbell.removed += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        expect(argv).toEqual(["/bin/sh", "-c", "ps -o pgid= -p $PPID"]);
        if (pgid === "throw") throw new Error("no ps");
        return { exitCode: 0, stdout: pgid, stderr: "" };
      },
    },
    http: {
      fetch: async (url: string, init: { body: string }) => {
        posted.push({ url, envelope: JSON.parse(init.body) });
        return { status, ok: status < 300, headers: {}, text: "" };
      },
    },
  };
  const fire = async (name: string, e: unknown, result: unknown = e) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    const out = await handler($, recordOf(e, "hook event"), async () => result);
    // Let the wire's queue post what was published.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return out;
  };
  const events = () =>
    posted
      .filter(({ envelope }) => envelope.type === "agent.status")
      .map(({ envelope }) => stringOf(recordOf(recordOf(recordOf(envelope, "envelope").payload, "payload").event, "event").hook_event_name, "event name"));
  const ring = async () => {
    doorbell.up = true;
    for (const timer of timers) await timer.tick();
  };
  return {
    $,
    handlers,
    posted,
    fire,
    events,
    timers,
    doorbell,
    submitted,
    ring,
    answerSubmit: (answer: unknown) => (submitAnswer = answer),
  };
}

/** A second module polling the SAME doorbell — what a reload leaves beside
 * its predecessor — with its own state, sharing the fake world. */
async function loadedTwin(first: ReturnType<typeof loaded>) {
  const twinHandlers = new Map<string, Handler>();
  register((name: string, handler: Handler) => twinHandlers.set(name, handler));
  const ticks: (() => Promise<void>)[] = [];
  const $ = {
    ...first.$,
    // Both pollers looked before either took it: the race the rename settles.
    fs: { exists: async () => true },
    clock: { every: (_ms: number, tick: () => Promise<void>) => (ticks.push(tick), { cancel() {} }) },
  };
  await present(twinHandlers.get("session.start"), "the entry for \"session.start\"")($, {}, async (e: unknown) => e);
  for (const tick of ticks) await tick();
}

const userAppend = (over: Record<string, unknown> = {}) => ({
  message: { type: "user", role: "user", content: [{ type: "text", text: "hi" }] },
  door: "prompt",
  origin: { kind: "composer" },
  uuid: "u-1",
  ...over,
});

describe("KeepDeck's claude Mod", () => {
  it("says hello once, naming this claude's process group, then states the main agent's facts", async () => {
    const mod = loaded();
    await mod.fire("session.start", { cwd: "/repo" });
    expect(mod.posted).toEqual([
      {
        url: "http://127.0.0.1:9/envelope",
        envelope: {
          v: 2,
          type: "companion.hello",
          paneId: "p-1",
          token: "secret",
          payload: { agent: "claude", reporter: "4021" },
        },
      },
    ]);

    await mod.fire("turn.complete", { reason: "aborted", isAborted: true, turnId: "t-1" });
    const append = userAppend();
    await mod.fire("session.append", append, { message: append.message, uuid: "u-1" });
    expect(mod.events()).toEqual([MOD_INTERRUPT_EVENT, MOD_PROMPT_ACCEPTED_EVENT]);
    expect(mod.posted.every(({ envelope }) => envelope.payload.reporter === "4021")).toBe(true);
  });

  it("states nothing about a subagent, an ordinary ending, or a prompt not taken from the composer", async () => {
    const mod = loaded();
    await mod.fire("session.start", {});
    await mod.fire("turn.complete", { reason: "aborted", isAborted: true, agentId: "a-1" });
    await mod.fire("turn.complete", { reason: "answer", isAborted: false });
    const cases: [Record<string, unknown>, unknown][] = [
      [userAppend({ door: "queue", origin: { kind: "engine" } }), undefined],
      [userAppend({ origin: { kind: "plugin", name: "x" } }), undefined],
      [userAppend({ agentId: "a-1" }), undefined],
      [userAppend(), { deny: "refused" }],
      [userAppend(), { message: { type: "user", isMeta: true, content: [] }, uuid: "u" }],
      [userAppend(), { message: { type: "attachment", content: [] }, uuid: "u" }],
    ];
    for (const [input, result] of cases) {
      await mod.fire("session.append", input, result ?? { message: input.message, uuid: "u" });
    }
    expect(mod.events()).toEqual([]);
  });

  it("is inert outside a KeepDeck pane, and silent when it cannot name its process", async () => {
    for (const setup of [{ bridge: null }, { pgid: "" }, { pgid: "throw" }, { pgid: "12 34" }]) {
      const mod = loaded(setup);
      // A handler must still hand the event on, or claude would stall.
      expect(await mod.fire("session.start", { cwd: "/repo" })).toEqual({ cwd: "/repo" });
      await mod.fire("turn.complete", { reason: "aborted", isAborted: true });
      expect(mod.posted).toEqual([]);
    }
  });

  describe("which turn an abort belongs to", () => {
    /** A typed prompt as claude raises it: the row is appended, and only once
     * every hooked append settled does its turn start. */
    const typed = (mod: ReturnType<typeof loaded>, uuid: string) => {
      const append = userAppend({ uuid });
      return mod.fire("session.append", append, { message: append.message, uuid });
    };
    const start = (mod: ReturnType<typeof loaded>, turnId: string, agentId?: string) =>
      mod.fire("turn.start", { text: "hi", turnId, ...(agentId !== undefined && { agentId }) });
    const aborted = (mod: ReturnType<typeof loaded>, turnId: string, agentId?: string) =>
      mod.fire("turn.complete", { reason: "aborted", isAborted: true, turnId, ...(agentId !== undefined && { agentId }) });

    it("states no interrupt for a turn cut by a prompt sent while it ran", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await start(mod, "t-1");
      // Sent while a tool ran: the prompt's append reached the Mod before
      // the cut turn's queued turn.complete.
      await typed(mod, "u-2");
      await aborted(mod, "t-1");
      await start(mod, "t-2");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_PROMPT_ACCEPTED_EVENT]);
    });

    it("an Esc in the turn that took over still interrupts", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await start(mod, "t-1");
      await typed(mod, "u-2");
      await aborted(mod, "t-1");
      await start(mod, "t-2");
      await aborted(mod, "t-2");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_PROMPT_ACCEPTED_EVENT, MOD_INTERRUPT_EVENT]);
    });

    it("a genuine Esc interrupts, also after a queued prompt was folded in", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await start(mod, "t-1");
      // A mid-turn fold is an attachment row, not an accepted prompt.
      const fold = userAppend({ uuid: "a-1", door: "delivery" });
      await mod.fire("session.append", fold, { message: { type: "attachment", content: [] }, uuid: "a-1" });
      await aborted(mod, "t-1");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_INTERRUPT_EVENT]);
    });

    it("Esc, then a new prompt: both stated, in order", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await start(mod, "t-1");
      await aborted(mod, "t-1");
      await typed(mod, "u-2");
      await start(mod, "t-2");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_INTERRUPT_EVENT, MOD_PROMPT_ACCEPTED_EVENT]);
    });

    it("a prompt after a turn ended normally supersedes nothing: the next turn's Esc interrupts", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await start(mod, "t-1");
      await mod.fire("turn.complete", { reason: "answer", isAborted: false, turnId: "t-1" });
      // The ended turn is still the last started when this prompt lands.
      await typed(mod, "u-2");
      await start(mod, "t-2");
      await aborted(mod, "t-2");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_PROMPT_ACCEPTED_EVENT, MOD_INTERRUPT_EVENT]);
    });

    it("a subagent's turns neither open nor close the main one", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await start(mod, "t-1");
      await start(mod, "s-1", "a-1");
      await aborted(mod, "s-1", "a-1");
      await aborted(mod, "t-1");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_INTERRUPT_EVENT]);
    });

    it("an abort of a turn it never saw start still interrupts", async () => {
      const mod = loaded();
      await mod.fire("session.start", {});
      await typed(mod, "u-1");
      await aborted(mod, "t-0");
      expect(mod.events()).toEqual([MOD_PROMPT_ACCEPTED_EVENT, MOD_INTERRUPT_EVENT]);
    });
  });

  it("hands every event on to claude", async () => {
    const mod = loaded();
    await mod.fire("session.start", {});
    const complete = { reason: "aborted", isAborted: true };
    expect(await mod.fire("turn.complete", complete, "next-result")).toBe("next-result");
    expect(await mod.fire("turn.start", { text: "hi", turnId: "t-1" }, "started")).toBe("started");
    const result = { message: userAppend().message, uuid: "u-1" };
    expect(await mod.fire("session.append", userAppend(), result)).toBe(result);
  });

  it("answers the doorbell by taking it down and starting a turn with the terminal's own line", async () => {
    const mod = loaded();
    await mod.fire("session.start", {});
    expect(mod.timers.map((timer) => timer.ms)).toEqual([100]);
    // Nothing rung: nothing submitted.
    for (const timer of mod.timers) await timer.tick();
    expect(mod.submitted).toEqual([]);
    await mod.ring();
    expect(mod.doorbell.removed).toBe(1);
    expect(mod.submitted).toEqual([
      "[keepdeck] A teammate's message is waiting for you. This line is from KeepDeck, not from your user — read what is waiting with the keepdeck mail.inbox tool.",
    ]);
    // Taken down: the next tick does not ring again.
    for (const timer of mod.timers) await timer.tick();
    expect(mod.submitted).toHaveLength(1);
  });

  it("survives a refused or failing submit — the mail stays the deck's", async () => {
    const mod = loaded();
    await mod.fire("session.start", {});
    mod.answerSubmit({ drop: "the session was stopped and nobody has sent input since" });
    await mod.ring();
    mod.answerSubmit(new Error("engine gone"));
    await mod.ring();
    mod.answerSubmit({ text: "ok" });
    await mod.ring();
    expect(mod.submitted).toHaveLength(3);
  });

  it("watches no doorbell outside KeepDeck or without a name for its process", async () => {
    for (const setup of [{ bridge: null }, { pgid: "" }]) {
      const mod = loaded(setup);
      await mod.fire("session.start", {});
      expect(mod.timers).toEqual([]);
    }
  });

  it("a claude the deck refuses watches no doorbell and states nothing more", async () => {
    // A background worker of claude's daemon: it inherited a pane's bridge
    // but no longer runs in that pane's terminal, and the deck says so.
    const mod = loaded({ status: 403 });
    await mod.fire("session.start", {});
    expect(mod.posted.map(({ envelope }) => envelope.type)).toEqual(["companion.hello"]);
    expect(mod.timers).toEqual([]);
    await mod.fire("turn.complete", { reason: "aborted", isAborted: true });
    await mod.fire("session.start", {});
    expect(mod.posted).toHaveLength(1);
  });

  it("watches no doorbell when the deck could not be reached either", async () => {
    // Nothing answered: the deck may not know this Mod, and a doorbell it
    // never acknowledged is not one to answer.
    const mod = loaded({ status: 0 });
    await mod.fire("session.start", {});
    expect(mod.timers).toEqual([]);
  });

  it("one ring is one turn even with two pollers, and a second session.start starts none", async () => {
    const mod = loaded();
    await mod.fire("session.start", {});
    await mod.fire("session.start", {});
    expect(mod.timers).toHaveLength(1);
    expect(mod.posted.filter(({ envelope }) => envelope.type === "companion.hello")).toHaveLength(1);
    // A reloaded module beside its predecessor: both see the same ring.
    mod.doorbell.up = true;
    await present(mod.timers[0], "the first mod.timers").tick();
    await loadedTwin(mod);
    expect(mod.doorbell.removed).toBe(1);
    expect(mod.submitted).toHaveLength(1);
  });
});
