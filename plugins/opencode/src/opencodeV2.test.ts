import { mkdtempSync, readFileSync, rmSync, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitMail } from "@keepdeck/plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDeck } from "../../../scripts/reporterHarness";
import { HEARTBEAT_MS, writeForeground } from "../resources/keepdeck-plugin/foreground.js";
import { OPENCODE_MAIL_CHANNELS, renderOpencodeMail } from "./mail";
import { attributeOpencodeEvent } from "./status";
import { present } from "@keepdeck/plugin-api/testing";

/** Every directory watcher the plugin opens, and those it closed. A watcher
 * left running after cleanup shows nothing a test could wait for — it only
 * follows a screen or a ring nobody makes — so the cleanup case counts them.
 * The real `watch` underneath: what it watches still fires. */
const watchers = vi.hoisted(() => ({ opened: [] as FSWatcher[], closed: [] as FSWatcher[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (path: string, listener: () => void) => {
      const watcher = actual.watch(path, listener);
      watchers.opened.push(watcher);
      watcher.on("close", () => watchers.closed.push(watcher));
      return watcher;
    },
  };
});

/**
 * KeepDeck's plugin on opencode 2.x, driven through a stand-in of the
 * `setup(context)` domains it uses — shapes from packages/plugin/src/promise
 * at v2.1.2 — against a stand-in deck on a real socket.
 */

/** A bus a test pushes 2.x events into: `{ type, data }`. */
function createBus() {
  const queued: unknown[] = [];
  let wake: (() => void) | undefined;
  return {
    push(type: string, data: Record<string, unknown>) {
      queued.push({ id: `evt_${queued.length}`, type, data });
      wake?.();
    },
    async *subscribe() {
      for (;;) {
        while (queued.length > 0) yield queued.shift();
        await new Promise<void>((resume) => (wake = resume));
      }
    },
  };
}

type Hook = (event: unknown) => Promise<void> | void;

/** The 2.x domains the plugin touches, recording what it does with them. */
function createContext(parents: Record<string, string | undefined> = {}) {
  const bus = createBus();
  const hooks: Record<string, Hook> = {};
  const prompts: { sessionID: string; text: string }[] = [];
  const synthetics: { sessionID: string; text: string; resume?: boolean }[] = [];
  /** Both kinds of write into a session, in the order they were made. */
  const writes: string[] = [];
  const created: Record<string, unknown>[] = [];
  const interrupted: string[] = [];
  /** What a session the plugin creates does once it exists — as opencode
   * does, announce it on the bus (overridable per test). */
  const onCreate = { announce: true };
  const context = {
    event: { subscribe: () => bus.subscribe() },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: parents[sessionID],
        agent: "build",
        model: { providerID: "fixture", id: "probe" },
      }),
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        const id = `ses_made${created.length}`;
        if (onCreate.announce) bus.push("session.created", { sessionID: id });
        return { id };
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        interrupted.push(sessionID);
        return true;
      },
      // As opencode does: a prompt runs every plugin's prompt hook before it
      // is taken in — this courier's own included.
      prompt: async (input: { sessionID: string; text: string; metadata?: unknown }) => {
        const event = { sessionID: input.sessionID, prompt: { text: input.text }, metadata: input.metadata };
        await hooks["session.prompt"]?.(event);
        prompts.push({ sessionID: input.sessionID, text: event.prompt.text });
        writes.push(`prompt ${input.sessionID}`);
        return {};
      },
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        synthetics.push(input);
        writes.push(`synthetic ${input.sessionID}`);
        return {};
      },
      hook: async (name: string, callback: Hook) => {
        hooks[`session.${name}`] = callback;
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name: string, callback: Hook) => {
        hooks[`tool.${name}`] = callback;
        return { dispose: async () => {} };
      },
    },
    model: {
      // The shape 2.1.2 answers with (measured, task-375).
      list: async () => ({
        location: { directory: "/repo" },
        data: [{ id: "probe", providerID: "fixture", limit: { context: 200_000 } }],
      }),
    },
  };
  return { context, bus, hooks, prompts, synthetics, writes, created, interrupted, onCreate };
}

/** Taken before any case fakes timers: the test's own waiting is on real
 * time, whatever clock the plugin runs on. */
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 5));

describe("KeepDeck's plugin on opencode 2.x", () => {
  let dir: string;
  let deck: Awaited<ReturnType<typeof startDeck>>;
  /** Answers the deck hands out, in order, to an admitted mail ask. */
  let pending: unknown[];
  /** Every mail ask, as the deck received it. */
  let asked: { type: string; target: string }[];
  let setup: (context: unknown) => Promise<(() => void) | undefined>;
  /** What each setup handed back for opencode to clean up with. */
  let cleanups: (() => void)[];
  let drained: () => Promise<void>;
  let ambientSkipsApprovals: string | undefined;

  /** Through the deck's own admission, on opencode's own attribution. */
  const answerAsk: NonNullable<Parameters<typeof startDeck>[0]> = (envelope) => {
    const type = envelope?.payload?.event?.type;
    if (type !== "mail.ask" && type !== "mail.ask.tool") return { status: 204 };
    asked.push(envelope.payload.event);
    const admitted = admitMail(
      {
        attribute: attributeOpencodeEvent,
        mail: { channels: OPENCODE_MAIL_CHANNELS, render: renderOpencodeMail },
      },
      envelope.payload,
    );
    if ("refused" in admitted) return { status: 204 };
    const answer = pending.shift();
    return answer === undefined ? { status: 204 } : { status: 200, body: JSON.stringify(answer) };
  };

  beforeEach(async () => {
    vi.resetModules();
    // Resource JS — shipped to, and loaded by, the user's opencode
    // process; loaded fresh, as a new pane's process would.
    const { setupV2 } = await import("../resources/keepdeck-plugin/opencode-v2.js");
    cleanups = [];
    setup = async (context: unknown) => {
      const cleanup = await setupV2(context);
      if (typeof cleanup === "function") cleanups.push(cleanup);
      return cleanup;
    };
    ({ drained } = await import("../resources/keepdeck-plugin/keepdeck-bridge.js"));
    dir = mkdtempSync(join(tmpdir(), "kd-v2-"));
    pending = [];
    asked = [];
    deck = await startDeck(answerAsk);
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 2, dir, pane: "pane-3", token: "tok", url: deck.url });
    ambientSkipsApprovals = process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS;
    delete process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS;
  });

  afterEach(async () => {
    for (const cleanup of cleanups) cleanup();
    delete process.env.KEEPDECK_BRIDGE;
    delete process.env.KEEPDECK_OPENCODE_SESSION;
    if (ambientSkipsApprovals === undefined) delete process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS;
    else process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS = ambientSkipsApprovals;
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the plugin posted, once everything pushed so far was handled. */
  const reported = async () => {
    for (let round = 0; round < 6; round++) await tick();
    await drained();
    await deck.idle();
    return deck.envelopes.filter((envelope) => envelope?.payload?.event?.type?.startsWith?.("mail.") !== true);
  };
  const ofType = (all: typeof deck.envelopes, type: string) => all.filter((envelope) => envelope.type === type);
  const lastOf = (all: typeof deck.envelopes) => all[all.length - 1];
  const binding = (envelope: (typeof deck.envelopes)[number]) => ({
    sessionId: envelope.payload.sessionId,
    source: envelope.payload.source,
  });

  describe("binding", () => {
    it("binds the pane to its first conversation, and a later one as continuing", async () => {
      const { context, bus } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      bus.push("session.created", { sessionID: "ses_b" });

      expect(ofType(await reported(), "session.bound").map(binding)).toEqual([
        { sessionId: "ses_a", source: "startup" },
        { sessionId: "ses_b", source: "new" },
      ]);
    });

    it("binds a resumed pane, which fires no session.created, from its first turn", async () => {
      const { context, bus } = createContext();
      await setup(context);
      bus.push("session.execution.started", { sessionID: "ses_resumed" });

      const all = await reported();
      expect(ofType(all, "session.bound").map(binding)).toEqual([
        { sessionId: "ses_resumed", source: "startup" },
      ]);
    });

    it("binds a pane resumed into a known session at once, before that session says anything", async () => {
      // The launch names the session in the environment too (src/launch.ts):
      // the plugin's process never sees `-s`. Without it the pane waits for
      // the session's first event, and mail with it.
      process.env.KEEPDECK_OPENCODE_SESSION = "ses_r";
      const { context } = createContext();
      await setup(context);

      expect(ofType(await reported(), "session.bound").map(binding)).toEqual([
        { sessionId: "ses_r", source: "startup" },
      ]);
    });

    it("delivers a ring that was waiting before the resumed pane's plugin started", async () => {
      // The deck rang while opencode was still loading; the ring is on disk,
      // and the pane must already know where it goes when it is taken.
      process.env.KEEPDECK_OPENCODE_SESSION = "ses_r";
      pending.push({ v: 1, prompt: "while you were away" });
      writeFileSync(join(dir, "mail.wake"), "");
      const { context, prompts } = createContext();
      await setup(context);
      for (let round = 0; round < 60 && prompts.length === 0; round++) await tick();

      expect(prompts).toEqual([{ sessionID: "ses_r", text: "while you were away" }]);
    });

    it("holds the mail, not loses it, when the resumed session is gone", async () => {
      // Deleted between being recorded and being resumed: opencode cannot
      // find it, and writing into it fails. The deck would count the mail as
      // delivered — so it is not asked for until the session exists.
      process.env.KEEPDECK_OPENCODE_SESSION = "ses_gone";
      pending.push({ v: 1, prompt: "do not drop me" });
      writeFileSync(join(dir, "mail.wake"), "");
      const { context, prompts } = createContext();
      let lookedUp!: () => void;
      const lookup = new Promise<void>((resolve) => (lookedUp = resolve));
      context.session.get = async () => {
        lookedUp();
        throw new Error("Session not found: ses_gone");
      };
      await setup(context);
      // The plugin looked the session up and found it gone: whatever it does
      // with the waiting mail follows from that, and is on the wire by now.
      await lookup;
      await reported();

      expect(asked).toEqual([]);
      expect(pending).toHaveLength(1);
      expect(prompts).toEqual([]);
    });

    it("binds to the conversation, not the subagent, when a subagent speaks first", async () => {
      const { context, bus } = createContext({ ses_child: "ses_root" });
      await setup(context);
      bus.push("session.step.started", { sessionID: "ses_child", model: { id: "probe", providerID: "fixture" } });

      expect(ofType(await reported(), "session.bound").map((e) => e.payload.sessionId)).toEqual(["ses_root"]);
    });
  });

  describe("status", () => {
    it("forwards the pane's turn events whole, its data as properties", async () => {
      const { context, bus } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      bus.push("session.execution.started", { sessionID: "ses_a" });
      bus.push("session.execution.interrupted", { sessionID: "ses_a", reason: "user" });

      expect(ofType(await reported(), "agent.status").map((e) => e.payload.event)).toEqual([
        { type: "session.execution.started", properties: { sessionID: "ses_a" } },
        { type: "session.execution.interrupted", properties: { sessionID: "ses_a", reason: "user" } },
      ]);
    });

    it("states the old conversation's ending even when a new one begins right behind it", async () => {
      // The server answers slowly, so the reporter is still busy with the
      // first turn when the bus has already moved on. Nothing but the
      // reporter may move the pane meanwhile, or the old turn's ending is
      // read against the new conversation and dropped — the pane stays
      // "working" on a conversation that ended.
      const { context, bus } = createContext();
      const answer = context.session.get;
      context.session.get = async (input: { sessionID: string }) => {
        for (let round = 0; round < 3; round++) await tick();
        return answer(input);
      };
      await setup(context);
      bus.push("session.execution.started", { sessionID: "ses_a" });
      bus.push("session.execution.succeeded", { sessionID: "ses_a" });
      bus.push("session.created", { sessionID: "ses_b" });

      expect(ofType(await reported(), "agent.status").map((e) => e.payload.event.type)).toEqual([
        "session.execution.started",
        "session.execution.succeeded",
      ]);
    });

    it("keeps a subagent's turns off the pane", async () => {
      const { context, bus } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      bus.push("session.created", { sessionID: "ses_kid", parentID: "ses_a" });
      bus.push("session.execution.started", { sessionID: "ses_kid" });

      expect(ofType(await reported(), "agent.status")).toEqual([]);
    });

    it("forwards approval prompts", async () => {
      const normal = createContext();
      await setup(normal.context);
      normal.bus.push("permission.asked", { sessionID: "ses_a", id: "per_1" });
      expect(ofType(await reported(), "agent.status")).toHaveLength(1);
    });

    it("drops approval prompts for a pane that skips them", async () => {
      process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS = "1";
      const skipping = createContext();
      await setup(skipping.context);
      skipping.bus.push("permission.asked", { sessionID: "ses_a", id: "per_1" });
      skipping.bus.push("form.created", { form: { id: "frm_1", sessionID: "ses_a" } });
      // A form has no default answer to pick, so it still parks the pane.
      expect(ofType(await reported(), "agent.status").map((e) => e.payload.event.type)).toEqual(["form.created"]);
    });
  });

  describe("usage", () => {
    it("reports the pane's spend, its subagents' included, and the root's context", async () => {
      const { context, bus } = createContext();
      await setup(context);
      const tokens = (input: number) => ({ input, output: 10, reasoning: 0, cache: { read: 5, write: 0 } });
      bus.push("session.created", { sessionID: "ses_a" });
      bus.push("session.created", { sessionID: "ses_kid", parentID: "ses_a" });
      bus.push("session.step.started", { sessionID: "ses_a", model: { id: "probe", providerID: "fixture" } });
      bus.push("session.usage.updated", { sessionID: "ses_kid", cost: 0.5, tokens: tokens(300) });
      bus.push("session.usage.updated", { sessionID: "ses_a", cost: 1, tokens: tokens(100) });
      bus.push("session.step.ended", { sessionID: "ses_a", cost: 1, tokens: tokens(100) });

      const last = lastOf(ofType(await reported(), "usage.report"))?.payload;
      expect(last).toMatchObject({
        sessionId: "ses_a",
        model: "probe",
        windowTokens: 200_000,
        // The root's last finished step is what its context holds.
        contextTokens: 115,
        totals: { input: 400, output: 20, reasoning: 0, cacheRead: 10, cacheWrite: 0 },
        costUsd: 1.5,
      });
    });

    it("starts a new conversation's spend from nothing", async () => {
      const { context, bus } = createContext();
      await setup(context);
      const tokens = { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      bus.push("session.created", { sessionID: "ses_a" });
      bus.push("session.usage.updated", { sessionID: "ses_a", cost: 1, tokens });
      await reported();
      bus.push("session.created", { sessionID: "ses_b" });
      bus.push("session.usage.updated", { sessionID: "ses_b", cost: 0.25, tokens });
      bus.push("session.step.ended", { sessionID: "ses_b", cost: 0.25, tokens });

      expect(lastOf(ofType(await reported(), "usage.report"))?.payload).toMatchObject({
        sessionId: "ses_b",
        costUsd: 0.25,
      });
    });
  });

  describe("mail", () => {
    it("puts the brief in a new conversation without a turn, and somebody's words with one", async () => {
      const { context, bus, prompts, synthetics, writes } = createContext();
      await setup(context);
      pending.push({ v: 1, context: "you are impl-1", prompt: "ship it" });
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();

      expect(synthetics).toEqual([{ sessionID: "ses_a", text: "you are impl-1", resume: false }]);
      expect(prompts).toEqual([{ sessionID: "ses_a", text: "ship it" }]);
      // The brief lands before the words that assume it.
      expect(writes).toEqual(["synthetic ses_a", "prompt ses_a"]);
    });

    it("collects at a turn's end", async () => {
      const { context, bus, prompts } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      pending.push({ v: 1, prompt: "next" });
      bus.push("session.execution.succeeded", { sessionID: "ses_a" });
      await reported();

      expect(prompts).toEqual([{ sessionID: "ses_a", text: "next" }]);
    });

    it("answers the doorbell for an idle pane", async () => {
      const { context, bus, prompts } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      pending.push({ v: 1, prompt: "rung" });
      writeFileSync(join(dir, "mail.wake"), "");
      for (let round = 0; round < 40 && prompts.length === 0; round++) await tick();

      expect(prompts).toEqual([{ sessionID: "ses_a", text: "rung" }]);
    });

    it("rides along in the user's own prompt, for the pane's conversation only", async () => {
      const { context, bus, hooks } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      bus.push("session.created", { sessionID: "ses_kid", parentID: "ses_a" });
      await reported();
      pending.push({ v: 1, prompt: "from lead" }, { v: 1, prompt: "also waiting" });
      const other = { sessionID: "ses_kid", prompt: { text: "task" } };
      await present(hooks["session.prompt"], "the session.prompt hook")(other);
      const mine = { sessionID: "ses_a", prompt: { text: "hi" } };
      await present(hooks["session.prompt"], "the session.prompt hook")(mine);

      expect(mine.prompt.text).toBe("hi\n\nfrom lead");
      expect(other.prompt.text).toBe("task");
      // A subagent's prompt is not even asked about.
      expect(asked.filter((ask) => ask.target !== "root")).toEqual([]);
    });

    it("rides back to the model with a tool's result, mid-turn", async () => {
      const { context, bus, hooks } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      pending.push({ v: 1, prompt: "stop and rebase" });
      const event = {
        sessionID: "ses_a",
        status: "completed",
        result: { content: [{ type: "text", text: "3 files changed" }] },
      };
      await present(hooks["tool.execute.after"], "the tool.execute.after hook")(event);

      expect(event.result.content).toEqual([
        { type: "text", text: "3 files changed" },
        { type: "text", text: "stop and rebase" },
      ]);
    });

    it("keeps a tool's output when its result carries no content", async () => {
      const { context, bus, hooks } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      pending.push({ v: 1, prompt: "note" });
      const event: { sessionID: string; status: string; result: { output: unknown; content?: unknown } } = {
        sessionID: "ses_a",
        status: "completed",
        result: { output: { files: 3 } },
      };
      await present(hooks["tool.execute.after"], "the tool.execute.after hook")(event);

      expect(event.result.content).toEqual([
        { type: "text", text: '{"files":3}' },
        { type: "text", text: "note" },
      ]);
    });

    it("delivers by the doorbell without waiting on itself, and leaves the pane usable", async () => {
      // opencode runs this courier's prompt hook for the courier's own
      // prompt; the hook once waited on the very collection delivering it, and
      // every prompt after it hung (2.1.2, task-375).
      const { context, bus, hooks, prompts } = createContext();
      await setup(context);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      pending.push({ v: 1, prompt: "rung" }, { v: 1, prompt: "should not ride" });
      writeFileSync(join(dir, "mail.wake"), "");
      for (let round = 0; round < 40 && prompts.length === 0; round++) await tick();
      // The user can still send; what is waiting rides along with it.
      const mine = { sessionID: "ses_a", prompt: { text: "hi" } };
      await present(hooks["session.prompt"], "the session.prompt hook")(mine);

      // The courier's own prompt carried only its own words.
      expect(prompts).toEqual([{ sessionID: "ses_a", text: "rung" }]);
      expect(mine.prompt.text).toBe("hi\n\nshould not ride");
    });

    it("asks nothing for a pane with no conversation yet", async () => {
      const { context, prompts } = createContext();
      await setup(context);
      pending.push({ v: 1, prompt: "early" });
      writeFileSync(join(dir, "mail.wake"), "");
      await reported();

      expect(prompts).toEqual([]);
      expect(pending).toHaveLength(1);
    });
  });

  describe("following the TUI's screen (task-436)", () => {
    // The follower's heartbeat and the courier's wait for a shown session
    // run on the test's clock here, advanced by the product's own constant.
    // The screen's watcher and the deck stay real.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
      watchers.opened.length = 0;
      watchers.closed.length = 0;
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    /** The 2.x TUI half's record: written by the TUI process, the plugin's
     * parent under `--standalone`. */
    const screen = (route: Record<string, unknown>, pid = process.ppid) =>
      writeForeground(dir, route, Date.now(), pid);
    /** Move the plugin's clock: run the timers due within `ms`, then one
     * turn of the event loop for what they started. */
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };
    /** A screen the user moved to, as the follower reads it: at once from
     * the watcher, and by the next heartbeat whatever the watcher did. */
    const show = async (route: Record<string, unknown>, pid?: number) => {
      screen(route, pid);
      await advance(HEARTBEAT_MS);
    };
    /** Wait for `done` — something the real watcher or the deck brings. Its
     * ceiling fails the case: a wait that runs it out is waiting for the
     * wrong thing, and passing anyway would hide it. */
    const until = async (done: () => boolean, rounds = 400) => {
      for (let round = 0; round < rounds && !done(); round++) await tick();
      if (!done()) throw new Error("until: waited out its ceiling for something that never came");
    };
    const posted = () => deck.envelopes.map((e) => (e.type === "agent.status" ? e.payload?.event?.type : e.type));
    const asks = () => asked.filter((a) => a.type === "mail.ask").length;

    /** The pane bound to `ses_a`, shown on screen. */
    const onA = async () => {
      const ctx = createContext();
      await setup(ctx.context);
      ctx.bus.push("session.created", { sessionID: "ses_a" });
      // The follower has read the screen by its next heartbeat at the
      // latest: the directory watcher can drop the write's event, and a home
      // screen it never saw a session before is not a leaving.
      await show({ route: "session", sessionID: "ses_a" });
      await reported();
      deck.envelopes.length = 0;
      asked.length = 0;
      return ctx;
    };

    it("moves the pane to the session the user opens — the binding first, and stops nothing", async () => {
      const { bus, interrupted } = await onA();
      await show({ route: "session", sessionID: "ses_b" });
      await until(() => posted().includes("session.bound"));
      bus.push("session.execution.started", { sessionID: "ses_b" });
      const all = await reported();

      expect(ofType(all, "session.bound").map(binding)).toEqual([{ sessionId: "ses_b", source: "resume" }]);
      // The new session's events are the pane's now, and come after its binding.
      const order = posted();
      expect(order.indexOf("session.execution.started")).toBeGreaterThan(order.indexOf("session.bound"));
      // A tab left behind runs on (user decision): nothing was interrupted.
      expect(interrupted).toEqual([]);
    });

    it("on /new lets the conversation go at once — the tab runs on, and no background tab takes the pane", async () => {
      const { bus, interrupted } = await onA();
      await show({ route: "home" });
      await until(() => posted().includes("session.unbound"));
      expect(posted()).toContain("session.unbound");
      expect(interrupted).toEqual([]);

      deck.envelopes.length = 0;
      // The tab left behind finishes, and another background tab works: the
      // home screen shows neither, so neither is the pane's.
      bus.push("session.execution.succeeded", { sessionID: "ses_a" });
      bus.push("session.execution.started", { sessionID: "ses_x" });
      bus.push("session.usage.updated", { sessionID: "ses_x", tokens: { input: 5, output: 1 }, cost: 0.1 });
      const all = await reported();
      expect(ofType(all, "usage.report")).toEqual([]);
      expect(ofType(all, "session.bound")).toEqual([]);
      expect(posted()).not.toContain("session.execution.succeeded");
      expect(posted()).not.toContain("session.execution.started");

      // The user's first prompt from home makes the next conversation.
      bus.push("session.created", { sessionID: "ses_c" });
      expect(ofType(await reported(), "session.bound").map(binding)).toEqual([{ sessionId: "ses_c", source: "new" }]);
    });

    it("binds a conversation again when the user comes back to it after /new", async () => {
      await onA();
      await show({ route: "home" });
      await until(() => posted().includes("session.unbound"));
      deck.envelopes.length = 0;
      await show({ route: "session", sessionID: "ses_a" });
      await until(() => posted().includes("session.bound"));
      expect(ofType(await reported(), "session.bound").map(binding)).toEqual([{ sessionId: "ses_a", source: "resume" }]);
    });

    it("reaches nobody where the user is not looking — not at a turn's end, not after a tool call", async () => {
      const { bus, hooks, prompts } = await onA();
      // A plugin's own page: no session on screen.
      await show({ route: "other" });
      await reported();
      pending.push({ v: 1, prompt: "should wait" });
      bus.push("session.execution.succeeded", { sessionID: "ses_a" });
      const result = { content: "done" };
      const call = { sessionID: "ses_a", status: "completed", result };
      await present(hooks["tool.execute.after"], "the tool.execute.after hook")(call);
      await reported();
      expect(asks()).toBe(0);
      expect(prompts).toEqual([]);
      expect(call.result).toBe(result);

      // Back on it, the waiting mail goes at the next boundary — asked for
      // then, not on the screen's change.
      await show({ route: "session", sessionID: "ses_a" });
      bus.push("session.execution.succeeded", { sessionID: "ses_a" });
      await until(() => prompts.length > 0);
      expect(asks()).toBe(1);
      expect(prompts).toEqual([{ sessionID: "ses_a", text: "should wait" }]);
    });

    it("after /new, a ring makes a session in the left one's agent and model, has the TUI show it, then delivers", async () => {
      const { created, prompts, synthetics } = await onA();
      await show({ route: "home" });
      await until(() => posted().includes("session.unbound"));
      // The TUI half — its own process, on real time: shows what it is asked
      // to while on the home screen.
      let tuiShowed!: () => void;
      const showed = new Promise<void>((resolve) => (tuiShowed = resolve));
      const tui = realSetInterval(() => {
        try {
          const request = JSON.parse(readFileSync(join(dir, "show.json"), "utf8"));
          rmSync(join(dir, "show.json"));
          screen({ route: "session", sessionID: request.sessionID });
          tuiShowed();
        } catch {
          // Nothing asked yet.
        }
      }, 20);
      try {
        pending.push({ v: 1, context: "brief", prompt: "after /new" });
        writeFileSync(join(dir, "mail.wake"), "");
        // The courier waits on its own clock for the session to come on
        // screen: once the TUI showed it, a heartbeat's time sees it there.
        await showed;
        await advance(HEARTBEAT_MS);
        await until(() => prompts.length > 0);
      } finally {
        realClearInterval(tui);
      }
      expect(created).toEqual([{ agent: "build", model: { providerID: "fixture", id: "probe" } }]);
      // Into the session made for it: the brief as context, the words as a turn.
      expect(synthetics).toEqual([{ sessionID: "ses_made1", text: "brief", resume: false }]);
      expect(prompts).toEqual([{ sessionID: "ses_made1", text: "after /new" }]);
      // Shown and bound before the mail was asked for.
      const order = posted();
      expect(order.indexOf("session.bound")).toBeGreaterThanOrEqual(0);
      const askAt = deck.envelopes.findIndex((e) => e?.payload?.event?.type === "mail.ask");
      expect(askAt).toBeGreaterThan(order.indexOf("session.bound"));
    });

    it("trusts only its parent's record — its own pid's is not the TUI's", async () => {
      await onA();
      await show({ route: "session", sessionID: "ses_wrong" }, process.pid);
      // Then the TUI's own record: it binds, so the follower has read past
      // the wrong one — and that one must not have bound first.
      await show({ route: "session", sessionID: "ses_b" });
      await until(() => posted().includes("session.bound"));
      expect(ofType(await reported(), "session.bound").map(binding)).toEqual([{ sessionId: "ses_b", source: "resume" }]);
    });

    it("stops everything when opencode cleans the plugin up", async () => {
      const { context, bus, prompts } = createContext();
      const cleanup = await setup(context);
      expect(typeof cleanup).toBe("function");
      // The screen's follower and the courier's doorbell.
      expect(watchers.opened).toHaveLength(2);
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();
      present(cleanup, "the cleanup")();
      // Every watcher closed — a ring or a screen would otherwise still be
      // followed — and nothing left on the plugin's clock: no heartbeat
      // reads the screen again. A watcher says it closed on its own event.
      await until(() => watchers.closed.length === watchers.opened.length);
      expect(watchers.closed).toEqual(expect.arrayContaining(watchers.opened));
      expect(vi.getTimerCount()).toBe(0);
      // And opencode's own events reach nobody.
      deck.envelopes.length = 0;
      bus.push("session.execution.started", { sessionID: "ses_a" });
      await reported();
      expect(deck.envelopes).toEqual([]);
      expect(prompts).toEqual([]);
    });
  });

  it("stays inert outside KeepDeck, and on a host that is not 2.x", async () => {
    const { context, bus, prompts } = createContext();
    await expect(setup({})).resolves.toBeUndefined();
    delete process.env.KEEPDECK_BRIDGE;
    await setup(context);
    bus.push("session.created", { sessionID: "ses_a" });
    await reported();
    expect(deck.envelopes).toEqual([]);
    expect(prompts).toEqual([]);
  });
});
