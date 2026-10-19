import { describe, expect, it } from "vitest";
// The Mod exactly as claude loads it — plain JS beside its copy of the wire.
// @ts-expect-error untyped resource module
import { register } from "../resources/keepdeck-mod/hooks/register.js";
import { MOD_INTERRUPT_EVENT, MOD_PROMPT_ACCEPTED_EVENT } from "./status";

const BRIDGE = JSON.stringify({
  v: 2,
  dir: "/run/p-1",
  pane: "p-1",
  token: "secret",
  url: "http://127.0.0.1:9/envelope",
});

type Handler = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown;

/** The Mod registered against a fake claude: its handlers by event, and a
 * `$` whose env, process and HTTP the test controls. */
function loaded({ bridge = BRIDGE as string | null, pgid = "4021\n" } = {}) {
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
        if (argv[0] === "/bin/rm") {
          expect(argv).toEqual(["/bin/rm", "-f", "/run/p-1/mail.wake"]);
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
        return { status: 204, ok: true, headers: {}, text: "" };
      },
    },
  };
  const fire = async (name: string, e: unknown, result: unknown = e) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    const out = await handler($, e, async () => result);
    // Let the wire's queue post what was published.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return out;
  };
  const events = () =>
    posted
      .filter(({ envelope }) => envelope.type === "agent.status")
      .map(({ envelope }) => (envelope.payload.event as { hook_event_name: string }).hook_event_name);
  const ring = async () => {
    doorbell.up = true;
    for (const timer of timers) await timer.tick();
  };
  return {
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
      await mod.fire("session.append", input, result ?? { message: (input as { message: unknown }).message, uuid: "u" });
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

  it("hands every event on to claude", async () => {
    const mod = loaded();
    await mod.fire("session.start", {});
    const complete = { reason: "aborted", isAborted: true };
    expect(await mod.fire("turn.complete", complete, "next-result")).toBe("next-result");
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
});
