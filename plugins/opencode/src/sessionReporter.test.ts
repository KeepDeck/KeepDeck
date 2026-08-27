import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDeck } from "../../../scripts/reporterHarness";
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
  let deck: Awaited<ReturnType<typeof startDeck>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kd-reporter-"));
    deck = await startDeck();
    process.env.KEEPDECK_BRIDGE = JSON.stringify({
      v: 2,
      dir,
      pane: "pane-3",
      token: "tok",
      url: deck.url,
    });
  });

  afterEach(async () => {
    delete process.env.KEEPDECK_BRIDGE;
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The envelopes the reporter posted to the deck.
   *
   * Async, and that is the shape of the change: this reporter fires and
   * forgets, and it used to forget a synchronous file write. A post is still
   * in flight when the call returns, so reading what was reported means
   * waiting for it to land.
   */
  const envelopes = async (): Promise<any[]> => {
    await deck.idle();
    return deck.envelopes as any[];
  };

  const usageReports = async () =>
    (await envelopes())
      .filter((envelope) => envelope.type === "usage.report")
      .sort((a, b) => a.payload.sequence - b.payload.sequence);

  it("binds the pane to a root session", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));

    expect((await envelopes())).toEqual([
      {
        v: 2,
        type: "session.bound",
        paneId: "pane-3",
        token: "tok",
        payload: {
          sessionId: "ses_root",
          agent: "opencode",
          source: "startup",
          // This reporter runs INSIDE the agent process, so the process the
          // deck pins the pane to is the one running these tests.
          reporter: String(process.pid),
        },
      },
    ]);
  });

  it("reports a later root as the pane's conversation continuing, not a new arrival", async () => {
    // `/new` mints a second root in the SAME pane process. The deck binds one
    // fresh session per process and treats every later one as somebody
    // else's, so saying `startup` twice would cost the user their `/new`.
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(created("ses_second"));

    // Keyed by session, not positional: these are posted concurrently and
    // arrive in whatever order the deck accepts them (which is why the usage
    // helper sorts by sequence — a binding carries none).
    expect(
      Object.fromEntries(
        (await envelopes()).map(({ payload }) => [payload.sessionId, payload.source]),
      ),
    ).toEqual({ ses_root: "startup", ses_second: "new" });
  });

  it("binds a resumed child event to its root, never to the leaf", async () => {
    const { event } = await reporter();
    await event(created("ses_child", "ses_root"));

    expect((await envelopes())).toEqual([
      expect.objectContaining({
        type: "session.bound",
        payload: {
          sessionId: "ses_root",
          agent: "opencode",
          source: "startup",
          // This reporter runs INSIDE the agent process, so the process the
          // deck pins the pane to is the one running these tests.
          reporter: String(process.pid),
        },
      }),
    ]);
  });

  it("binds a pane resumed mid-task to its conversation, not to the subagent", async () => {
    // A resumed pane (`-s <id>`, how every pane comes back after a restart)
    // fires no root `session.created`, so its first completed message is the
    // only thing that names its conversation. If that message is a
    // subagent's — a pane resumed while a task was running — this bound the
    // pane to a leaf that ends, and reported the subagent's turns as the
    // pane's until it did. The parent is ASKED for, the same way the mail
    // courier asks, so the two plugins cannot disagree about which session
    // is the pane's.
    const asked: unknown[] = [];
    const withParents = {
      ...client,
      session: {
        get: async (args: { path: { id: string } }) => {
          asked.push(args);
          return args.path.id === "ses_child"
            ? { data: { id: "ses_child", parentID: "ses_root" } }
            : { data: { id: args.path.id } };
        },
      },
    };
    const { event } = await reporter({ client: withParents });
    await event(assistantMessage({ sessionID: "ses_child" }));

    // Asked in the path shape this client wants, not the flat one — and the
    // PARENT is resolved too, so a chain arriving unseen cannot leave the
    // pane rooted at a middle link.
    expect(asked).toEqual([
      { path: { id: "ses_child" } },
      { path: { id: "ses_root" } },
    ]);
    expect(
      (await envelopes()).find((envelope) => envelope.type === "session.bound")?.payload
        .sessionId,
    ).toBe("ses_root");
  });

  it("keeps a subagent's spend after binding through it", async () => {
    // `activateRoot` clears the index — a new root is a new generation — and
    // that threw away the parent link the classify had just bought. Every
    // later message from the same subagent then resolved to itself, failed
    // the root check, and its spend never reached the pane's total. The fake
    // client below answers `session.get` and nothing else, which is exactly
    // the case hydration cannot repair.
    const withParents = {
      ...client,
      session: {
        get: async (args: { path: { id: string } }) =>
          args.path.id === "ses_child"
            ? { data: { id: "ses_child", parentID: "ses_root" } }
            : { data: { id: args.path.id } },
      },
    };
    const { event } = await reporter({ client: withParents });
    // The binding turn, then a SECOND subagent turn — the one the cleared
    // index used to drop — and finally a root turn, since only a root turn
    // publishes (occupancy and model identity are the root's).
    await event(assistantMessage({ sessionID: "ses_child" }));
    await event(assistantMessage({ id: "msg_2", sessionID: "ses_child" }));
    await event(assistantMessage({ id: "msg_3", sessionID: "ses_root" }));

    const reports = (await usageReports());
    // All three turns, at 0.1 each. Two means the middle one was lost.
    expect(reports[reports.length - 1]?.payload.costUsd).toBeCloseTo(0.3);
  });

  it("walks a whole chain, and keeps every hop of it after binding", async () => {
    // A pane resumed mid-task can see a GRANDCHILD first. One hop of
    // ancestry roots the pane in the middle of the chain — a subagent that
    // ends — and clearing the index on bind threw away whatever the walk had
    // learned, so every intermediate session's spend was dropped from then
    // on.
    const tree: Record<string, string | undefined> = {
      ses_c2: "ses_c1",
      ses_c1: "ses_root",
    };
    const deep = {
      ...client,
      session: {
        get: async (args: { path: { id: string } }) => ({
          data: { id: args.path.id, parentID: tree[args.path.id] },
        }),
      },
    };
    const { event } = await reporter({ client: deep });
    await event(assistantMessage({ sessionID: "ses_c2" }));
    // The middle link's own turn, which only counts if the chain survived.
    await event(assistantMessage({ id: "msg_2", sessionID: "ses_c1" }));
    await event(assistantMessage({ id: "msg_3", sessionID: "ses_c2" }));
    await event(assistantMessage({ id: "msg_4", sessionID: "ses_root" }));

    expect(
      (await envelopes()).find((envelope) => envelope.type === "session.bound")?.payload
        .sessionId,
    ).toBe("ses_root");
    const reports = (await usageReports());
    expect(reports[reports.length - 1]?.payload.costUsd).toBeCloseTo(0.4);
  });

  it("asks again about a session the client could not answer for", async () => {
    // "Could not tell" is not an answer and is remembered nowhere, so a
    // transient failure does not fix the pane's identity for the process's
    // life. A real answer IS remembered, and is not asked twice.
    const asked: string[] = [];
    let failing = true;
    const flaky = {
      ...client,
      session: {
        get: async (args: { path: { id: string } }) => {
          asked.push(args.path.id);
          return failing
            ? { error: { name: "UnknownError" } }
            : { data: { id: args.path.id } };
        },
      },
    };
    const { event } = await reporter({ client: flaky });
    await event(assistantMessage({ sessionID: "ses_a" }));
    expect(asked).toEqual(["ses_a"]);

    failing = false;
    // A second pane-less reporter would be a different instance, so drive the
    // same one: a fresh root arrives and is asked about on its own terms.
    await event(created("ses_b"));
    await event(assistantMessage({ id: "msg_2", sessionID: "ses_b" }));
    expect(asked).toEqual(["ses_a"]);
  });

  it("treats a session the client cannot answer about as the pane's own", async () => {
    // The generated client RESOLVES with `{error}` rather than throwing —
    // measured on 1.18.15, and documented in this very file. Reading that as
    // "no parent" would bind the pane to a subagent on the one path this
    // whole mechanism exists for. Unknown means unknown, and an unknown
    // session is taken as the pane's own, because a pane bound to nothing is
    // never reachable again.
    const refusing = {
      ...client,
      session: { get: async () => ({ error: { name: "UnknownError" } }) },
    };
    const { event } = await reporter({ client: refusing });
    await event(assistantMessage({ sessionID: "ses_resumed" }));

    expect(
      (await envelopes()).find((envelope) => envelope.type === "session.bound")?.payload
        .sessionId,
    ).toBe("ses_resumed");
  });

  it("ignores a child that belongs to another active root", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(created("ses_other_child", "ses_other_root"));

    expect((await envelopes())).toEqual([
      expect.objectContaining({
        type: "session.bound",
        payload: {
          sessionId: "ses_root",
          agent: "opencode",
          source: "startup",
          // This reporter runs INSIDE the agent process, so the process the
          // deck pins the pane to is the one running these tests.
          reporter: String(process.pid),
        },
      }),
    ]);
  });

  it("ignores events that are not a session creation", async () => {
    const { event } = await reporter();
    await event({ event: { type: "session.updated", properties: { info: { id: "ses_x" } } } });

    expect((await envelopes())).toEqual([]);
  });

  it("stays inert outside KeepDeck", async () => {
    delete process.env.KEEPDECK_BRIDGE;
    expect(await reporter()).toEqual({});
  });

  it("stays inert when the bridge envelope is incomplete", async () => {
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 2, dir });
    expect(await reporter()).toEqual({});
  });

  it("reports usage on a completed assistant message", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage());

    expect((await usageReports())).toEqual([
      {
        v: 2,
        type: "usage.report",
        paneId: "pane-3",
        token: "tok",
        payload: {
          agent: "opencode",
          // Every lane this reporter publishes names its process: the deck
          // pins the pane to one and refuses reports from another.
          reporter: String(process.pid),
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
    const reports = (await usageReports());
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

    const reports = (await usageReports());
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
    // The SHAPE is the contract, and it is measured, not assumed: on opencode
    // 1.18.15 the plugin's client takes the session id as a PATH parameter
    // (`{path:{id}}`) and answers `{error: UnknownError}` to the flat
    // `{sessionID}` form — which it RESOLVES with rather than throwing. This
    // stub used to accept the flat form, so hydration read as working while
    // every real call came back empty. It now refuses what the real client
    // refuses.
    const forId = (call: { path?: { id?: string } }) => call.path?.id;
    const hydrated = {
      ...client,
      session: {
        messages: async (call: { path?: { id?: string } }) => {
          const id = forId(call);
          if (!id) return { error: { name: "UnknownError" } };
          return { data: id === "ses_root" ? [{ info: rootOld }] : [{ info: childOld }] };
        },
        children: async (call: { path?: { id?: string } }) => {
          const id = forId(call);
          if (!id) return { error: { name: "UnknownError" } };
          return { data: id === "ses_root" ? [{ id: "ses_child" }] : [] };
        },
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

    expect((await usageReports())[0].payload).toMatchObject({
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
    expect((await usageReports())[0].payload.windowTokens).toBe(100);
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
    expect((await usageReports()).map((report) => report.payload)).toMatchObject([
      { model: "model-a", windowTokens: 100, contextTokens: 11, sequence: 1 },
      { model: "model-b", windowTokens: 200, contextTokens: 22, sequence: 2 },
    ]);
  });

  it("ignores a streaming (not-yet-completed) assistant message", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage({ time: {} }));
    expect((await envelopes())).toEqual([]);
  });

  it("ignores a non-assistant message", async () => {
    const { event } = await reporter({ client });
    await event(assistantMessage({ role: "user" }));
    expect((await envelopes())).toEqual([]);
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

    const [envelope] = (await usageReports());
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

    const reports = (await usageReports());
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

    const reports = (await usageReports());
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
    for (const r of (await usageReports())) expect(r.payload.totals.input).toBe(1000);
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
    expect((await usageReports())).toHaveLength(1);
  });

  /** The agent.status envelopes the reporter posted, in event order. */
  const statusEvents = async () =>
    (await envelopes())
      .filter((envelope) => envelope.type === "agent.status")
      .map((envelope) => envelope.payload.event);

  /**
   * The payload travels WHOLE. What used to leave this process was a reduced
   * copy — `session.status` only when busy, `error.name` flattened to a bare
   * string — and both reductions were decisions about meaning taken a process
   * away from where meaning is decided. The retry state disappeared behind
   * the first, and the eight error names apart from which an abort cannot be
   * told from a failure disappeared behind the second.
   */
  it("forwards the pane's turn events verbatim, properties and all", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_root", status: { type: "busy" } },
      },
    });
    await event({
      event: { type: "session.idle", properties: { sessionID: "ses_root" } },
    });
    await event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_root",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      },
    });
    const events = (await statusEvents());
    expect(events).toHaveLength(3);
    expect(events).toContainEqual({
      type: "session.status",
      properties: { sessionID: "ses_root", status: { type: "busy" } },
    });
    expect(events).toContainEqual({
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    expect(events).toContainEqual({
      type: "session.error",
      properties: {
        sessionID: "ses_root",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    });
    // Every envelope carries the pane's own correlation.
    for (const envelope of (await envelopes())) {
      expect(envelope.paneId).toBe("pane-3");
      expect(envelope.token).toBe("tok");
    }
  });

  it("forwards an idle STATUS too — which of the three kinds it is, is not this side's call", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_root", status: { type: "retry", attempt: 2 } },
      },
    });
    expect((await statusEvents())).toEqual([
      {
        type: "session.status",
        properties: { sessionID: "ses_root", status: { type: "retry", attempt: 2 } },
      },
    ]);
  });

  it("reports an error the CLI attached to no session — this process serves one pane", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event({
      event: {
        type: "session.error",
        properties: { error: { name: "UnknownError" } },
      },
    });
    expect((await statusEvents())).toEqual([
      { type: "session.error", properties: { error: { name: "UnknownError" } } },
    ]);
  });

  it("ignores a child session's busy/idle — a subagent is not the pane's turn", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(created("ses_child", "ses_root"));
    await event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "busy" } },
      },
    });
    await event({
      event: { type: "session.idle", properties: { sessionID: "ses_child" } },
    });
    // An unrelated ROOT session in the same server is not this pane either.
    await event({
      event: { type: "session.idle", properties: { sessionID: "ses_other" } },
    });
    expect((await statusEvents())).toEqual([]);
  });

  /**
   * A dialog parks the TERMINAL, whichever session put it up: a subagent's
   * request holds the frame of the turn that spawned it, so "waiting for a
   * human" is true of the pane either way. A root filter here would
   * manufacture a turn that never ends.
   */
  it("forwards dialogs without a session filter — including a subagent's", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(created("ses_child", "ses_root"));
    await event({
      event: { type: "permission.asked", properties: { sessionID: "ses_child" } },
    });
    await event({
      event: { type: "permission.replied", properties: { sessionID: "ses_child" } },
    });
    await event({
      event: { type: "question.asked", properties: { sessionID: "ses_child" } },
    });
    await event({
      event: { type: "question.rejected", properties: { sessionID: "ses_child" } },
    });
    const events = (await statusEvents());
    expect(events.map((e: any) => e.type)).toEqual([
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.rejected",
    ]);
  });

  /**
   * The question surface was not forwarded at all, and nothing else on the
   * bus reports it: while a choice stands open no idle arrives and the status
   * does not change, so the pane read "Working" at a terminal that was
   * waiting on its user.
   */
  /**
   * With approvals skipped, opencode answers its own prompt in milliseconds
   * and the reply is indistinguishable from a person's — so every one of
   * them announced "needs approval" for a dialog that never appeared. The
   * pane's launch mode is the only thing that tells the two apart, and it
   * cannot be read from inside the agent's process.
   */
  it("says nothing about approvals the pane will never be asked for", async () => {
    process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS = "1";
    try {
      const { event } = await reporter();
      await event(created("ses_root"));
      await event({
        event: { type: "permission.asked", properties: { sessionID: "ses_root" } },
      });
      await event({
        event: {
          type: "permission.replied",
          properties: { sessionID: "ses_root", reply: "once" },
        },
      });
      // The question surface is untouched: nothing can auto-pick an option,
      // so that dialog really does stand and wait.
      await event({
        event: { type: "question.asked", properties: { sessionID: "ses_root" } },
      });
      expect((await statusEvents()).map((e: any) => e.type)).toEqual([
        "question.asked",
      ]);
    } finally {
      delete process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS;
    }
  });

  it("forwards a question, the one wait nothing else on the bus reports", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event({
      event: {
        type: "question.asked",
        properties: {
          sessionID: "ses_root",
          questions: [{ question: "colour?", options: [{ label: "red" }] }],
        },
      },
    });
    expect((await statusEvents())).toEqual([
      {
        type: "question.asked",
        properties: {
          sessionID: "ses_root",
          questions: [{ question: "colour?", options: [{ label: "red" }] }],
        },
      },
    ]);
  });

  /**
   * An interrupt caught between steps writes its name onto the message and
   * publishes no error event at all — so a FINISHED message has to travel,
   * or that turn reads as an ordinary Done. A streaming frame does not: it is
   * a fragment of content, not a fact about the turn.
   */
  it("forwards a finished message, which carries endings no event does", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(assistantMessage({ error: { name: "MessageAbortedError" } }));
    const forwarded = (await statusEvents());
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].type).toBe("message.updated");
    expect(forwarded[0].properties.info.error).toEqual({
      name: "MessageAbortedError",
    });
  });

  it("does not forward a message still streaming", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));
    await event(assistantMessage({ time: {} }));
    expect((await statusEvents())).toEqual([]);
  });

  /**
   * An abort states two facts a fraction of a millisecond apart — the error
   * first, then the idle behind it — and the deck keeps whichever it reads
   * first. Posting both without waiting hands that choice to the network:
   * measured on the real reporter, 3 of 50 aborts arrived inverted, and the
   * deck then read a finished turn where an interrupted one was reported.
   *
   * Held responses are what makes this visible. With them, a sender that
   * fires-and-forgets has both posts open at once; a sender that queues never
   * has more than one, whatever the timings.
   */
  it("states one fact at a time, so the deck reads an abort in the order it happened", async () => {
    await deck.close();
    // 25ms is wide enough that an unqueued second post lands inside the first
    // one's window, and narrow enough to keep the suite quick.
    deck = await startDeck(undefined, 25);
    process.env.KEEPDECK_BRIDGE = JSON.stringify({
      v: 2,
      dir,
      pane: "pane-3",
      token: "tok",
      url: deck.url,
    });

    const { event } = await reporter();
    await event(created("ses_root"));
    await event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_root",
          error: { name: "MessageAbortedError" },
        },
      },
    });
    await event({
      event: { type: "session.idle", properties: { sessionID: "ses_root" } },
    });

    // Three envelopes, each held 25ms — poll rather than guess a total.
    const deadline = Date.now() + 2000;
    while (deck.envelopes.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(deck.peakInFlight()).toBe(1);
    expect((await statusEvents()).map((e: any) => e.type)).toEqual([
      "session.error",
      "session.idle",
    ]);
  });
});
