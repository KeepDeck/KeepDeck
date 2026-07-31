import { describe, expect, it, vi } from "vitest";
import type { AgentHistory } from "@keepdeck/plugin-api";
import { scanAgentHistories, type ScanIndexOps } from "./historyScan";

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
  const mock: ScanIndexOps = {
    refs: vi.fn(async () => stored),
    upsert: vi.fn(async (_agent, rows) => {
      upserts.push(...rows);
    }),
    prune: vi.fn(async (_agent, live) => {
      prunes.push(live);
      return 0;
    }),
  };
  return { mock, upserts, prunes };
};

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
      ],
      mock,
    );
    expect((upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual(["b"]);
  });
});
