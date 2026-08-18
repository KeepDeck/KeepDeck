import { describe, expect, it, vi } from "vitest";
import type { AgentHistory } from "@keepdeck/plugin-api";
import {
  scanAgentHistories,
  type AgentScanOutcome,
  type ScanIndexOps,
} from "./historyScan";

vi.mock("../ipc/history", () => ({
  indexRefs: vi.fn(),
  indexUpsert: vi.fn(),
  indexPrune: vi.fn(),
  indexSearch: vi.fn(),
  pluginsSqliteQuery: vi.fn(),
}));
vi.mock("../ipc/log", () => ({
  describeError: (e: unknown) => String(e),
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const history = (over: Partial<AgentHistory> = {}): AgentHistory => ({
  list: async () => [
    { sessionId: "a", ref: "/s/a", mtime: 5, size: 10 },
    { sessionId: "b", ref: "/s/b", mtime: 9, size: 20 },
  ],
  describe: async (ref) => ({ cwd: `/cwd${ref}`, title: `t${ref}` }),
  content: async (ref) => `content of ${ref}`,
  transcript: async () => [],
  ...over,
});

const ops = (stored: { reference: string; mtime: number; size: number }[]) => {
  const upserts: unknown[] = [];
  const prunes: unknown[] = [];
  const dropped: Array<{ agent: string; sessionId: string }> = [];
  const mock: ScanIndexOps = {
    refs: vi.fn(async () => stored),
    upsert: vi.fn(async (_agent, rows) => {
      upserts.push(...rows);
    }),
    prune: vi.fn(async (agent: string, live: string[]) => {
      prunes.push(live);
      // Report every stored ref NOT in live as dropped — the double the
      // real index returns.
      const liveSet = new Set(live);
      return stored
        .filter((r) => !liveSet.has(r.reference))
        .map((r) => ({
          agent,
          sessionId: r.reference.slice(r.reference.lastIndexOf("/") + 1),
        }));
    }),
  };
  return { mock, upserts, prunes, dropped };
};

const stub = (
  sessionId: string,
  mtime = 5,
  size = 10,
): { sessionId: string; ref: string; mtime: number; size: number } => ({
  sessionId,
  ref: `/s/${sessionId}`,
  mtime,
  size,
});

describe("scanAgentHistories", () => {
  it("opens only new/changed sessions, prunes vanished refs", async () => {
    const { mock, upserts, prunes } = ops([
      { reference: "/s/a", mtime: 5, size: 10 }, // unchanged → untouched
      { reference: "/s/gone", mtime: 1, size: 1 }, // vanished → pruned
    ]);
    await scanAgentHistories([{ agentId: "claude", history: history() }], mock);

    expect(upserts).toEqual([
      {
        sessionId: "b",
        reference: "/s/b",
        cwd: "/cwd/s/b",
        title: "t/s/b",
        transcriptPath: null,
        mtime: 9,
        size: 20,
        content: "content of /s/b",
      },
    ]);
    expect(prunes).toEqual([["/s/a", "/s/b"]]);
  });

  it("an empty listing over a non-empty index skips the prune", async () => {
    // Every agent's list() degrades a read failure to [] — indistinguishable
    // from "the CLI deleted every session". Pruning on it would wipe the
    // agent's whole history from the browser.
    const { mock, prunes } = ops([{ reference: "/s/a", mtime: 5, size: 10 }]);
    await scanAgentHistories(
      [{ agentId: "claude", history: history({ list: async () => [] }) }],
      mock,
    );
    expect(prunes).toEqual([]);
  });

  it("an empty listing over an empty index still prunes (a genuinely new agent)", async () => {
    const { mock, prunes } = ops([]);
    await scanAgentHistories(
      [{ agentId: "claude", history: history({ list: async () => [] }) }],
      mock,
    );
    // Nothing indexed, nothing to lose — the ordinary path stays exercised
    // so the guard can't silently widen.
    expect(prunes).toEqual([[]]);
  });

  it("a failing session skips; a failing agent doesn't sink the others", async () => {
    const { mock, upserts } = ops([]);
    await scanAgentHistories(
      [
        { agentId: "broken", history: history({ list: async () => { throw new Error("dead store"); } }) },
        {
          agentId: "claude",
          history: history({
            describe: async (ref) => {
              if (ref === "/s/a") throw new Error("torn");
              return { cwd: "/x" };
            },
          }),
        },
        // Companion for the partial-listing era: a PARTIAL agent is not a
        // failing one — it indexes what it read, prunes nothing, and no more
        // sinks its neighbors than a whole-store failure does.
        {
          agentId: "partial",
          history: history({
            listing: async () => ({ stubs: [stub("p")], complete: false }),
          }),
        },
      ],
      mock,
    );
    expect((upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual([
      "b",
      "p",
    ]);
  });

  it("an incomplete listing indexes what it read and prunes nothing", async () => {
    const { mock, upserts, prunes } = ops([
      { reference: "/s/a", mtime: 5, size: 10 },
      { reference: "/s/gone", mtime: 1, size: 1 },
    ]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            listing: async () => ({ stubs: [stub("a"), stub("b")], complete: false }),
          }),
        },
      ],
      mock,
    );
    // b is new → described and upserted; gone vanished but the walk saw
    // only part of the store, so deleting it would be deleting the unread.
    expect((upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual(["b"]);
    expect(prunes).toEqual([]);
  });

  it("a complete listing prunes vanished refs, exactly as list() did", async () => {
    const { mock, prunes } = ops([
      { reference: "/s/a", mtime: 5, size: 10 },
      { reference: "/s/gone", mtime: 1, size: 1 },
    ]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            listing: async () => ({ stubs: [stub("a"), stub("b")], complete: true }),
          }),
        },
      ],
      mock,
    );
    expect(prunes).toEqual([["/s/a", "/s/b"]]);
  });

  it("recovery: a partial pass deleted nothing, so the next complete pass catches up both ways", async () => {
    // Pass 1: b's directory unreadable — b never indexed, /s/gone never
    // pruned. Pass 2: everything reads — b lands AND the stale ref goes.
    const pass1 = ops([
      { reference: "/s/a", mtime: 5, size: 10 },
      { reference: "/s/gone", mtime: 1, size: 1 },
    ]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            listing: async () => ({ stubs: [stub("a")], complete: false }),
          }),
        },
      ],
      pass1.mock,
    );
    expect(pass1.prunes).toEqual([]);

    const pass2 = ops([
      { reference: "/s/a", mtime: 5, size: 10 },
      { reference: "/s/gone", mtime: 1, size: 1 },
    ]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            listing: async () => ({
              stubs: [stub("a"), stub("b", 9, 20)],
              complete: true,
            }),
          }),
        },
      ],
      pass2.mock,
    );
    expect((pass2.upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual(["b"]);
    expect(pass2.prunes).toEqual([["/s/a", "/s/b"]]);
  });

  it("an unreadable root — nothing read, incomplete — never prunes", async () => {
    // The most dangerous shape: an empty answer over a NON-empty index.
    // Were it complete, prune would read [] as "every session deleted"
    // and wipe the agent's whole history.
    const { mock, prunes } = ops([{ reference: "/s/a", mtime: 5, size: 10 }]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            listing: async () => ({ stubs: [], complete: false }),
          }),
        },
      ],
      mock,
    );
    expect(prunes).toEqual([]);
  });

  it("the per-agent outcome classifies the walk — proof is complete only", async () => {
    const outcomeOf = async (
      over: Partial<AgentHistory>,
      stored: { reference: string; mtime: number; size: number }[] = [],
    ): Promise<AgentScanOutcome | undefined> => {
      const { mock } = ops(stored);
      const report = await scanAgentHistories(
        [{ agentId: "claude", history: history(over) }],
        mock,
      );
      return report.outcomes.get("claude");
    };

    // A clean full walk over a whole store: certified.
    expect(await outcomeOf({})).toBe("complete");

    // A describe/content refusal over a PROVEN file: the store holds it,
    // the index never got it — certifying would arm a false verdict.
    expect(
      await outcomeOf({
        describe: async () => {
          throw new Error("read refused");
        },
      }),
    ).toBe("partial");

    // An incomplete listing walked something, not everything.
    expect(
      await outcomeOf({
        list: async () => [],
        listing: async () => ({ stubs: [], complete: false }),
      }),
    ).toBe("partial");

    // The degraded legacy empty listing over a non-empty index: partial,
    // never certified, never pruned.
    expect(
      await outcomeOf(
        { list: async () => [] },
        [{ reference: "/s/a", mtime: 5, size: 10 }],
      ),
    ).toBe("partial");

    // The agent's whole pass refusing: failed — and the OTHER agent's
    // outcome survives beside it.
    const { mock } = ops([]);
    const both = await scanAgentHistories(
      [
        { agentId: "claude", history: history() },
        {
          agentId: "codex",
          history: history({
            list: async () => {
              throw new Error("store refused");
            },
            listing: async () => {
              throw new Error("store refused");
            },
          }),
        },
      ],
      mock,
    );
    expect(both.outcomes.get("claude")).toBe("complete");
    expect(both.outcomes.get("codex")).toBe("failed");
  });

  it("pruned sessions ride the report as dropped keys — the cache's invalidation signal", async () => {
    // The index holds a and b; the store now lists only a. Prune names
    // exactly b — not a count, the KEY, so a per-key answer cache can
    // devalue precisely what it lost.
    const { mock } = ops([
      { reference: "/s/a", mtime: 5, size: 10 },
      { reference: "/s/b", mtime: 9, size: 20 },
    ]);
    const report = await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            list: async () => [{ sessionId: "a", ref: "/s/a", mtime: 5, size: 10 }],
          }),
        },
      ],
      mock,
    );
    expect(report.dropped).toEqual([{ agent: "claude", sessionId: "b" }]);
  });

  it("a listing() refusal falls back to list(), not to skipping the agent", async () => {
    // A slow external guest's realm timeout is a PERMANENT refusal —
    // without the fallback this agent's history would never update again.
    const { mock, upserts, prunes } = ops([]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: history({
            listing: async () => {
              throw new Error("realm timeout");
            },
          }),
        },
      ],
      mock,
    );
    expect((upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(prunes).toEqual([["/s/a", "/s/b"]]);
  });
});
