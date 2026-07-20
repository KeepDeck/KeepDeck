import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The reporter is untyped resource JS — it is shipped to, and loaded by, the
// user's opencode process, never bundled into the plugin.
// @ts-expect-error untyped resource module
import reporter from "../resources/session-reporter.js";

/** An opencode `session.created` event; `parentID` marks a CHILD session. */
const created = (id: string, parentID?: string) => ({
  event: { type: "session.created", properties: { info: { id, parentID } } },
});

/** An opencode assistant `message.updated` for a COMPLETED turn. */
const assistantMessage = (over: Record<string, unknown> = {}) => ({
  event: {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1",
        role: "assistant",
        sessionID: "ses_root",
        modelID: "claude-sonnet-5",
        time: { completed: 1 },
        cost: 0.1,
        tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 0 } },
        ...over,
      },
    },
  },
});

/** A mock SDK client exposing the provider catalog the reporter reads. */
const client = {
  config: {
    providers: async () => ({
      data: {
        providers: [{ models: { "claude-sonnet-5": { limit: { context: 200_000 } } } }],
      },
    }),
  },
};

describe("opencode session reporter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kd-reporter-"));
    process.env.KEEPDECK_BRIDGE = JSON.stringify({
      v: 1,
      dir,
      pane: "pane-3",
      token: "tok",
    });
  });

  afterEach(() => {
    delete process.env.KEEPDECK_BRIDGE;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The envelopes the reporter dropped in the bridge inbox. */
  const envelopes = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

  it("binds the pane to a root session", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));

    expect(envelopes()).toEqual([
      {
        v: 1,
        type: "session.bound",
        paneId: "pane-3",
        token: "tok",
        payload: { sessionId: "ses_root", agent: "opencode" },
      },
    ]);
  });

  it("ignores a child session so the pane never rebinds to a leaf", async () => {
    const { event } = await reporter();
    await event(created("ses_child", "ses_root"));

    expect(envelopes()).toEqual([]);
  });

  it("ignores events that are not a session creation", async () => {
    const { event } = await reporter();
    await event({ event: { type: "session.updated", properties: { info: { id: "ses_x" } } } });

    expect(envelopes()).toEqual([]);
  });

  it("stays inert outside KeepDeck", async () => {
    delete process.env.KEEPDECK_BRIDGE;
    expect(await reporter()).toEqual({});
  });

  it("stays inert when the bridge envelope is incomplete", async () => {
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir });
    expect(await reporter()).toEqual({});
  });

  it("reports usage on a completed assistant message", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage());

    expect(envelopes()).toEqual([
      {
        v: 1,
        type: "usage.report",
        paneId: "pane-3",
        token: "tok",
        payload: {
          agent: "opencode",
          sessionId: "ses_root",
          model: "claude-sonnet-5",
          windowTokens: 200_000,
          contextTokens: 6200, // 1000 + 200 + 0 + 5000 + 0
          totals: { input: 1000, output: 200, reasoning: 0, cacheRead: 5000, cacheWrite: 0 },
          lastTurn: { input: 1000, output: 200, reasoning: 0, cacheRead: 5000, cacheWrite: 0 },
          costUsd: 0.1,
        },
      },
    ]);
  });

  it("sums per-message tokens and cost across the session", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage());
    await event(
      assistantMessage({
        id: "msg_2",
        cost: 0.2,
        tokens: { input: 500, output: 100, cache: { read: 6000 } },
      }),
    );

    // Inbox filenames are random UUIDs, so read order is arbitrary — the
    // final cumulative is the report with the largest (monotonic) total.
    const reports = envelopes().sort(
      (a, b) => a.payload.totals.input - b.payload.totals.input,
    );
    const last = reports[reports.length - 1];
    expect(last.payload.totals).toEqual({
      input: 1500,
      output: 300,
      reasoning: 0,
      cacheRead: 11_000,
      cacheWrite: 0,
    });
    expect(last.payload.costUsd).toBeCloseTo(0.3);
    // Occupancy reflects the LATEST message only, not the sum.
    expect(last.payload.contextTokens).toBe(6600);
  });

  it("ignores a streaming (not-yet-completed) assistant message", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage({ time: {} }));
    expect(envelopes()).toEqual([]);
  });

  it("ignores a non-assistant message", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage({ role: "user" }));
    expect(envelopes()).toEqual([]);
  });

  it("degrades to no window size when the provider catalog fails", async () => {
    const { event } = await reporter({
      client: {
        config: {
          providers: async () => {
            throw new Error("offline");
          },
        },
      },
    });
    await event(assistantMessage());

    const [envelope] = envelopes();
    expect(envelope.payload.windowTokens).toBeUndefined();
    expect(envelope.payload.contextTokens).toBe(6200);
  });

  it("retries the provider catalog after a transient first failure", async () => {
    let calls = 0;
    const flaky = {
      config: {
        providers: async () => {
          calls += 1;
          if (calls === 1) throw new Error("SDK not ready");
          return {
            data: {
              providers: [
                { models: { "claude-sonnet-5": { limit: { context: 200_000 } } } },
              ],
            },
          };
        },
      },
    };
    const { event } = await reporter({ client: flaky });
    await event(assistantMessage()); // call 1 throws → window unresolved
    await event(assistantMessage({ id: "msg_2" })); // call 2 succeeds → resolved

    const reports = envelopes().sort(
      (a, b) => a.payload.totals.input - b.payload.totals.input,
    );
    expect(reports[0].payload.windowTokens).toBeUndefined();
    expect(reports[reports.length - 1].payload.windowTokens).toBe(200_000);
  });

  it("counts subagent spend but keeps occupancy on the root conversation", async () => {
    const { event } = await reporter({ client });
    // A child (subagent) session is announced.
    await event({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_root" } },
      },
    });
    // A root turn establishes occupancy + identity.
    await event(
      assistantMessage({
        id: "msg_root",
        sessionID: "ses_root",
        cost: 0.1,
        tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 0 } },
      }),
    );
    // A subagent turn: its cost/tokens count, its occupancy must NOT.
    await event(
      assistantMessage({
        id: "msg_child",
        sessionID: "ses_child",
        cost: 0.4,
        tokens: { input: 300, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );

    const reports = envelopes().sort((a, b) => a.payload.costUsd - b.payload.costUsd);
    const last = reports[reports.length - 1];
    // The cumulative INCLUDES the subagent's real spend.
    expect(last.payload.costUsd).toBeCloseTo(0.5);
    expect(last.payload.totals.input).toBe(1300); // 1000 + 300
    // Occupancy + identity stay the ROOT's, never the subagent's.
    expect(last.payload.sessionId).toBe("ses_root");
    expect(last.payload.contextTokens).toBe(6200); // root's 1000+200+5000
  });

  it("does not double-count when the same message id re-fires", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage());
    await event(assistantMessage()); // the SAME id (msg_1) again

    // Both envelopes carry msg_1's cumulative — the map replaced, not stacked.
    for (const r of envelopes()) expect(r.payload.totals.input).toBe(1000);
  });

  it("reads a message that sits directly on properties (no info nesting)", async () => {
    const { event } = await reporter({ client });
    await event({
      event: {
        type: "message.updated",
        properties: {
          id: "msg_1",
          role: "assistant",
          sessionID: "ses_root",
          modelID: "claude-sonnet-5",
          time: { completed: 1 },
          cost: 0.1,
          tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 0 } },
        },
      },
    });
    expect(envelopes()).toHaveLength(1);
  });
});
