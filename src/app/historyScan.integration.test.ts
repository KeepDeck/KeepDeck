import { describe, expect, it, vi } from "vitest";
import { createSessionStore, type FsEntry } from "@keepdeck/plugin-api";
import { fsStore } from "@keepdeck/plugin-api/testing";
import { scanAgentHistories, type ScanIndexOps } from "./historyScan";
import {
  claudeHistory,
  type HistoryPorts as ClaudeHistoryPorts,
} from "../../plugins/claude/src/history";
import { opencodeHistory, type HistoryPorts } from "../../plugins/opencode/src/history";

// The scan's own ipc surface never runs here — ops are injected below; the
// mock only keeps the module import from reaching tauri's invoke.
vi.mock("../ipc/history", () => ({
  indexRefs: vi.fn(),
  indexUpsert: vi.fn(),
  indexPrune: vi.fn(),
  indexSearch: vi.fn(),
  pluginsSqliteQuery: vi.fn(),
}));
vi.mock("../ipc/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/** In-memory index ops — the same shape the unit suite injects, so a real
 * plugin's rules meet the REAL scan loop here, not a replay of it. */
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
      return [];
    }),
  };
  return { mock, upserts, prunes };
};

/** An fs double in the plugin suites' own shape: dirs that answer, dirs
 * that throw — an absent key IS the unreadable directory. */
function fsCtx(
  files: Record<string, string>,
  dirs: Record<string, FsEntry[]>,
): ClaudeHistoryPorts {
  // A real plugin reads its store a window at a time, so the double serves
  // windows; `dirs` stays hand-built, because these tests are about what the
  // enumeration does with listings a real directory cannot pose.
  const fs = fsStore(files);
  return {
    // The partial walk NAMES the directories it skips — the double must
    // let it, or the plugin degrades to list() instead of reporting.
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    services: {
      fs: {
        readDir: async (path: string) => {
          const entries = dirs[path];
          if (!entries) throw new Error("no dir");
          return entries;
        },
      },
      sessionStore: createSessionStore(fs),
    },
  };
}

/** A sqlite double for the opencode plugin: a 1.x store's tables for the
 * shape question, then one answer per query. An answer the host's byte
 * budget cut short is spelled `{ cut: rows }`. */
function sqliteCtx(
  results: ((string | null)[][] | { cut: (string | null)[][] } | Error)[],
): { ctx: HistoryPorts; asked: () => string[] } {
  const query = vi.fn(async (_db: string, sql: string, _params?: string[]) => {
    const next = sql.includes("sqlite_master")
      ? [["session"], ["message"], ["part"]]
      : results.shift();
    if (next instanceof Error) throw next;
    const budget = next !== undefined && !Array.isArray(next);
    return {
      rows: budget ? next.cut : (next ?? []),
      stopped: budget ? ("budget" as const) : ("exhausted" as const),
      payloadBytes: 0,
    };
  });
  return {
    ctx: {
      services: { sqlite: { query } },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    asked: () =>
      query.mock.calls.map(([, sql]) => sql).filter((sql) => !sql.includes("sqlite_master")),
  };
}

describe("scanAgentHistories × real plugins", () => {
  it("claude: a real partial walk indexes what it read and the prune decision is NOT to delete", async () => {
    // The unreadable slug dir is invisible to readDir; the readable one
    // carries one real transcript. Through the REAL plugin the walk must
    // come back incomplete, index the readable session, and delete nothing.
    const transcript = [
      JSON.stringify({
        type: "user",
        cwd: "/repo",
        message: { role: "user", content: "fix the auth bug" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
      }),
    ].join("\n");
    const { mock, upserts, prunes } = ops([
      { reference: "/h/p/-gone/u.jsonl", mtime: 1, size: 1 },
    ]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: claudeHistory(
            fsCtx(
              { "/h/p/-repo/u.jsonl": transcript },
              {
                "~/.claude/projects": [
                  { name: "-repo", path: "/h/p/-repo", kind: "dir" },
                  { name: "-gone", path: "/h/p/-gone", kind: "dir" },
                ],
                "/h/p/-repo": [
                  { name: "u.jsonl", path: "/h/p/-repo/u.jsonl", kind: "file", size: 2, mtime: 5 },
                ],
                // "/h/p/-gone" deliberately absent → readDir throws.
              },
            ),
          ),
        },
      ],
      mock,
    );
    expect(upserts).toEqual([
      {
        sessionId: "u",
        reference: "/h/p/-repo/u.jsonl",
        cwd: "/repo",
        title: "fix the auth bug",
        transcriptPath: "/h/p/-repo/u.jsonl",
        mtime: 5,
        size: 2,
        content: "fix the auth bug\non it",
      },
    ]);
    // The embedding under test: the plugin's incomplete answer reached the
    // prune decision, and the decision was to keep the unread dir's rows.
    expect(prunes).toEqual([]);
  });

  it("claude: a full re-scan drops the orphaned row and indexes the agent-run conversations alike", async () => {
    // The order-of-work regression for the NAME filter: a schema bump
    // wipes the index and the next full scan must not plant the row whose
    // name is not an id. The agent-run transcript (agent-name in its head
    // — a marker once misread as "task copy") IS indexed: hiding on that
    // marker erased real five-day conversations. A genuine task's
    // transfer copy would also ride along as an extra row — a named,
    // accepted flaw; the only true discriminator is cross-file verbatim
    // comparison, out of scope here.
    const transcript = [
      JSON.stringify({ type: "mode", mode: "normal", sessionId: "u" }),
      JSON.stringify({
        type: "user",
        cwd: "/repo",
        message: { role: "user", content: "fix the auth bug" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
      }),
    ].join("\n");
    const agentRun = [
      JSON.stringify({ type: "ai-title", aiTitle: "kernel work", sessionId: "t" }),
      JSON.stringify({ type: "agent-name", agentName: "kernel work", sessionId: "t" }),
      JSON.stringify({
        type: "user",
        cwd: "/repo",
        message: { role: "user", content: "fix the audio stutter" },
      }),
    ].join("\n");
    const { mock, upserts, prunes } = ops([]);
    await scanAgentHistories(
      [
        {
          agentId: "claude",
          history: claudeHistory(
            fsCtx(
              {
                "/h/p/-repo/u.jsonl": transcript,
                "/h/p/-repo/t.jsonl": agentRun,
              },
              {
                "~/.claude/projects": [
                  { name: "-repo", path: "/h/p/-repo", kind: "dir" },
                ],
                "/h/p/-repo": [
                  { name: "u.jsonl", path: "/h/p/-repo/u.jsonl", kind: "file", size: 2, mtime: 5 },
                  { name: "t.jsonl", path: "/h/p/-repo/t.jsonl", kind: "file", size: 2, mtime: 6 },
                  {
                    name: "u2.orphaned-1786650822694-a024affe.jsonl",
                    path: "/h/p/-repo/u2.orphaned-1786650822694-a024affe.jsonl",
                    kind: "file",
                    size: 3,
                    mtime: 7,
                  },
                ],
              },
            ),
          ),
        },
      ],
      mock,
    );
    expect(upserts).toEqual([
      {
        sessionId: "u",
        reference: "/h/p/-repo/u.jsonl",
        cwd: "/repo",
        title: "fix the auth bug",
        transcriptPath: "/h/p/-repo/u.jsonl",
        mtime: 5,
        size: 2,
        content: "fix the auth bug\non it",
      },
      {
        sessionId: "t",
        reference: "/h/p/-repo/t.jsonl",
        cwd: "/repo",
        title: "fix the audio stutter",
        transcriptPath: "/h/p/-repo/t.jsonl",
        mtime: 6,
        size: 2,
        content: "fix the audio stutter",
      },
    ]);
    // The live set carries both real transcripts' refs; the orphaned name
    // never enters anything.
    expect(prunes).toEqual([
      ["/h/p/-repo/u.jsonl", "/h/p/-repo/t.jsonl"],
    ]);
  });

  it("opencode: a whole listing indexes and prunes, exactly as the legacy branch did", async () => {
    const { ctx, asked } = sqliteCtx([
      [
        ["ses_1", "1", "1769121238325", "0", "1"],
        ["ses_2", "1", "1769121299999", "0", "2"],
      ],
      [["/repo", "rail cleanup"]], // describe ses_1
      [["m1", "user"]], // content ses_1: its messages…
      [["m1", "hello", "1"]], // …and their text parts
      [["/other", "other"]], // describe ses_2
      [["m2", "user"]],
      [["m2", "world", "1"]],
    ]);
    const { mock, upserts, prunes } = ops([
      { reference: "ses_stale", mtime: 1, size: 0 },
    ]);
    await scanAgentHistories(
      [{ agentId: "opencode", history: opencodeHistory(ctx) }],
      mock,
    );
    expect((upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual([
      "ses_1",
      "ses_2",
    ]);
    expect(prunes).toEqual([["ses_1", "ses_2"]]);
    expect(asked()[0]).toContain("FROM session s");
    expect(asked()).toHaveLength(7);
  });

  it("opencode: a listing the host cut indexes what it saw and prunes NOTHING", async () => {
    // The reason this plugin was given `listing()`: on the legacy branch a
    // cut enumeration returned successfully, which meant "complete enough
    // to prune" — and every session past the cut would have been deleted
    // from the index for not appearing in it.
    const { ctx } = sqliteCtx([
      { cut: [["ses_1", "1", "1769121238325", "0", "1"]] },
      [["/repo", "rail cleanup"]],
      [["m1", "user"]],
      [["m1", "hello", "1"]],
    ]);
    const { mock, upserts, prunes } = ops([
      { reference: "ses_past_the_cut", mtime: 1, size: 0 },
    ]);
    await scanAgentHistories(
      [{ agentId: "opencode", history: opencodeHistory(ctx) }],
      mock,
    );
    expect((upserts as { sessionId: string }[]).map((r) => r.sessionId)).toEqual([
      "ses_1",
    ]);
    expect(prunes).toEqual([]);
  });

  it("opencode: an unreadable store prunes nothing — it is not an empty store", async () => {
    const { ctx } = sqliteCtx([new Error("no such db")]);
    const { mock, prunes } = ops([
      { reference: "ses_1", mtime: 1, size: 0 },
    ]);
    await scanAgentHistories(
      [{ agentId: "opencode", history: opencodeHistory(ctx) }],
      mock,
    );
    expect(prunes).toEqual([]);
  });
});
