import { describe, expect, it, vi } from "vitest";
import { createSessionStore, type PluginContext } from "@keepdeck/plugin-api";
import { fsStore } from "@keepdeck/plugin-api/testing";
import { scanAgentHistories, type ScanIndexOps } from "./historyScan";
import { claudeHistory } from "../../plugins/claude/src/history";
import { opencodeHistory } from "../../plugins/opencode/src/history";

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
  describeError: (e: unknown) => String(e),
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
  dirs: Record<string, unknown[]>,
): PluginContext {
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
        readFile: fs.readFile,
      },
      sessionStore: createSessionStore(fs),
    },
  } as unknown as PluginContext;
}

/** A sqlite double for the opencode plugin — one query, one answer. */
function sqliteCtx(
  results: ((string | null)[][] | Error)[],
): { ctx: PluginContext; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (..._args: unknown[]) => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  });
  return {
    ctx: { services: { sqlite: { query } } } as unknown as PluginContext,
    query,
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

  it("opencode: the untouched plugin rides the legacy branch — indexes and prunes exactly as before", async () => {
    // opencode has no listing(); enumerate() must send it down list(),
    // whose successful read has always meant "complete enough to prune".
    const text = (t: string) => JSON.stringify({ type: "text", text: t });
    const { ctx, query } = sqliteCtx([
      [["ses_1", "1769121238325"], ["ses_2", "1769121299999"]], // list()
      [["/repo", "rail cleanup"]], // describe ses_1
      [[text("hello")]], // content ses_1
      [["/other", "other"]], // describe ses_2
      [[text("world")]], // content ses_2
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
    // The legacy list() path really ran — not some listing() shortcut.
    expect(query.mock.calls[0][1]).toContain("time_archived IS NULL");
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("opencode: a missing store keeps the legacy empty-listing guard — no prune over a non-empty index", async () => {
    // The one behavior the legacy branch could have silently lost: list()
    // answers [] for an unreadable db, and pruning on that would wipe the
    // agent's history. The guard must still catch it on the legacy branch.
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
