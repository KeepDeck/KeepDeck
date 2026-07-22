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
        providerID: "anthropic",
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
        providers: [
          {
            id: "anthropic",
            models: { "claude-sonnet-5": { limit: { context: 200_000 } } },
          },
        ],
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

  const usageReports = () =>
    envelopes()
      .filter((envelope) => envelope.type === "usage.report")
      .sort((a, b) => a.payload.sequence - b.payload.sequence);

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

  it("binds a resumed child event to its root, never to the leaf", async () => {
    const { event } = await reporter();
    await event(created("ses_child", "ses_root"));

    expect(envelopes()).toEqual([
      expect.objectContaining({
        type: "session.bound",
        payload: { sessionId: "ses_root", agent: "opencode" },
      }),
    ]);
  });

  it("ignores a child that belongs to another active root", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(created("ses_other_child", "ses_other_root"));

    expect(envelopes()).toEqual([
      expect.objectContaining({
        type: "session.bound",
        payload: { sessionId: "ses_root", agent: "opencode" },
      }),
    ]);
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

    expect(usageReports()).toEqual([
      {
        v: 1,
        type: "usage.report",
        paneId: "pane-3",
        token: "tok",
        payload: {
          agent: "opencode",
          sessionId: "ses_root",
          model: "claude-sonnet-5",
          sequence: 1,
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

    // Inbox filenames are random UUIDs, so order by the reporter sequence.
    const reports = usageReports();
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

  it("starts a clean usage generation when /new creates another root", async () => {
    const { event } = await reporter({ client });
    await event(created("ses_old"));
    await event(
      assistantMessage({
        sessionID: "ses_old",
        tokens: { input: 10, output: 1, cache: {} },
        cost: 0.1,
      }),
    );
    await event(created("ses_new"));
    await event(
      assistantMessage({
        sessionID: "ses_new",
        tokens: { input: 20, output: 2, cache: {} },
        cost: 0.2,
      }),
    );

    const reports = usageReports();
    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.payload.sessionId === "ses_new")?.payload).toMatchObject({
      sessionId: "ses_new",
      sequence: 1,
      totals: { input: 20, output: 2 },
      costUsd: 0.2,
    });
  });

  it("hydrates root and child history before reporting a resumed turn", async () => {
    const rootOld = assistantMessage({
      id: "msg_old",
      tokens: { input: 100, output: 10, cache: {} },
      cost: 1,
    }).event.properties.info;
    const childOld = assistantMessage({
      id: "msg_child_old",
      sessionID: "ses_child",
      tokens: { input: 50, output: 5, cache: {} },
      cost: 0.5,
    }).event.properties.info;
    const hydrated = {
      ...client,
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "ses_root" ? [{ info: rootOld }] : [{ info: childOld }],
        }),
        children: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "ses_root" ? [{ id: "ses_child" }] : [],
        }),
      },
    };
    const { event } = await reporter({ client: hydrated });
    await event(
      assistantMessage({
        id: "msg_new",
        tokens: { input: 20, output: 2, cache: {} },
        cost: 0.2,
        time: { completed: 2 },
      }),
    );

    expect(usageReports()[0].payload).toMatchObject({
      sessionId: "ses_root",
      totals: { input: 170, output: 17 },
      lastTurn: { input: 20, output: 2 },
      costUsd: 1.7,
    });
  });

  it("resolves duplicate model ids inside the message's provider", async () => {
    const duplicateModels = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              { id: "provider-a", models: { shared: { limit: { context: 100 } } } },
              { id: "provider-b", models: { shared: { limit: { context: 1000 } } } },
            ],
          },
        }),
      },
    };
    const { event } = await reporter({ client: duplicateModels });
    await event(
      assistantMessage({ providerID: "provider-a", modelID: "shared" }),
    );
    expect(usageReports()[0].payload.windowTokens).toBe(100);
  });

  it("serializes callbacks that OpenCode itself invokes without awaiting", async () => {
    let resolveCatalog!: (value: unknown) => void;
    let catalogStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    });
    let calls = 0;
    const delayed = {
      config: {
        providers: () => {
          calls += 1;
          return new Promise((resolve) => {
            resolveCatalog = resolve;
            catalogStarted();
          });
        },
      },
    };
    const { event } = await reporter({ client: delayed });
    const first = event(
      assistantMessage({
        id: "msg_a",
        providerID: "provider-a",
        modelID: "model-a",
        tokens: { input: 10, output: 1, cache: {} },
      }),
    );
    const second = event(
      assistantMessage({
        id: "msg_b",
        providerID: "provider-b",
        modelID: "model-b",
        tokens: { input: 20, output: 2, cache: {} },
        time: { completed: 2 },
      }),
    );
    await started;
    resolveCatalog({
      data: {
        providers: [
          { id: "provider-a", models: { "model-a": { limit: { context: 100 } } } },
          { id: "provider-b", models: { "model-b": { limit: { context: 200 } } } },
        ],
      },
    });
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(usageReports().map((report) => report.payload)).toMatchObject([
      { model: "model-a", windowTokens: 100, contextTokens: 11, sequence: 1 },
      { model: "model-b", windowTokens: 200, contextTokens: 22, sequence: 2 },
    ]);
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

    const [envelope] = usageReports();
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
                {
                  id: "anthropic",
                  models: { "claude-sonnet-5": { limit: { context: 200_000 } } },
                },
              ],
            },
          };
        },
      },
    };
    const { event } = await reporter({ client: flaky });
    await event(assistantMessage()); // call 1 throws → window unresolved
    await event(assistantMessage({ id: "msg_2" })); // call 2 succeeds → resolved

    const reports = usageReports();
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

    const reports = usageReports();
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
    for (const r of usageReports()) expect(r.payload.totals.input).toBe(1000);
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
          providerID: "anthropic",
          modelID: "claude-sonnet-5",
          time: { completed: 1 },
          cost: 0.1,
          tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 0 } },
        },
      },
    });
    expect(usageReports()).toHaveLength(1);
  });
});
