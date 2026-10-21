import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitMail } from "@keepdeck/plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDeck } from "../../../scripts/reporterHarness";
import { OPENCODE_MAIL_CHANNELS, renderOpencodeMail } from "./mail";
import { attributeOpencodeEvent } from "./status";

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

type Hook = (event: any) => Promise<void> | void;

/** The 2.x domains the plugin touches, recording what it does with them. */
function createContext(parents: Record<string, string | undefined> = {}) {
  const bus = createBus();
  const hooks: Record<string, Hook> = {};
  const prompts: { sessionID: string; text: string }[] = [];
  const synthetics: { sessionID: string; text: string; resume?: boolean }[] = [];
  const context = {
    event: { subscribe: () => bus.subscribe() },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] }),
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input);
        return {};
      },
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        synthetics.push(input);
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
      list: async () => [{ id: "probe", providerID: "fixture", limit: { context: 200_000 } }],
    },
  };
  return { context, bus, hooks, prompts, synthetics };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("KeepDeck's plugin on opencode 2.x", () => {
  let dir: string;
  let deck: Awaited<ReturnType<typeof startDeck>>;
  /** Answers the deck hands out, in order, to an admitted mail ask. */
  let pending: unknown[];
  /** Every mail ask, as the deck received it. */
  let asked: { type: string; target: string }[];
  let setup: (context: unknown) => Promise<void>;
  let drained: () => Promise<void>;
  let ambientSkipsApprovals: string | undefined;

  /** Through the deck's own admission, on opencode's own attribution. */
  const answerAsk = (envelope: any) => {
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
    // Untyped resource JS — shipped to, and loaded by, the user's opencode
    // process; loaded fresh, as a new pane's process would.
    // @ts-expect-error untyped resource module
    ({ setupV2: setup } = await import("../resources/keepdeck-plugin/opencode-v2.js"));
    // @ts-expect-error untyped resource module
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
    delete process.env.KEEPDECK_BRIDGE;
    if (ambientSkipsApprovals === undefined) delete process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS;
    else process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS = ambientSkipsApprovals;
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the plugin posted, once everything pushed so far was handled. */
  const reported = async (): Promise<any[]> => {
    for (let round = 0; round < 6; round++) await tick();
    await drained();
    await deck.idle();
    return deck.envelopes.filter((envelope: any) => envelope?.payload?.event?.type?.startsWith?.("mail.") !== true);
  };
  const ofType = (all: any[], type: string) => all.filter((envelope) => envelope.type === type);
  const lastOf = (all: any[]) => all[all.length - 1];
  const binding = (envelope: any) => ({
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
      const { context, bus, prompts, synthetics } = createContext();
      await setup(context);
      pending.push({ v: 1, context: "you are impl-1", prompt: "ship it" });
      bus.push("session.created", { sessionID: "ses_a" });
      await reported();

      expect(synthetics).toEqual([{ sessionID: "ses_a", text: "you are impl-1", resume: false }]);
      expect(prompts).toEqual([{ sessionID: "ses_a", text: "ship it" }]);
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
      await hooks["session.prompt"]!(other);
      const mine = { sessionID: "ses_a", prompt: { text: "hi" } };
      await hooks["session.prompt"]!(mine);

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
      await hooks["tool.execute.after"]!(event);

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
      await hooks["tool.execute.after"]!(event);

      expect(event.result.content).toEqual([
        { type: "text", text: '{"files":3}' },
        { type: "text", text: "note" },
      ]);
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
