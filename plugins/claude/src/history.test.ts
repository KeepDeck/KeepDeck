import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { claudeHistory } from "./history";

const LINES = [
  JSON.stringify({
    type: "user",
    cwd: "/repo/wt",
    message: { role: "user", content: "<system-hint>noise</system-hint>" },
  }),
  JSON.stringify({
    type: "user",
    cwd: "/repo/wt",
    message: {
      role: "user",
      content: "Base directory for this skill: /u/.claude/skills/prime # Prime",
    },
  }),
  JSON.stringify({
    type: "user",
    cwd: "/repo/wt",
    message: { role: "user", content: "fix the auth bug" },
  }),
  '{"torn',
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "found it in refresh()" }],
    },
  }),
].join("\n");

function ctx(
  files: Record<string, string>,
  dirs: Record<string, unknown[]>,
  warn: (message: string) => void = vi.fn(),
) {
  return {
    log: { warn, info: vi.fn(), error: vi.fn() },
    services: {
      fs: {
        readDir: async (path: string) => {
          const entries = dirs[path];
          if (!entries) throw new Error("no dir");
          return entries;
        },
        readFile: async (path: string) => ({
          path,
          text: files[path] ?? null,
          isBinary: false,
          size: 0,
          truncated: false,
        }),
      },
    },
  } as unknown as PluginContext;
}

describe("claude history", () => {
  it("lists slug dirs' jsonl files as stubs", async () => {
    const history = claudeHistory(
      ctx({}, {
        "~/.claude/projects": [
          { name: "-repo-wt", path: "/h/p/-repo-wt", kind: "dir" },
        ],
        "/h/p/-repo-wt": [
          { name: "u1.jsonl", path: "/h/p/-repo-wt/u1.jsonl", kind: "file", size: 9, mtime: 5 },
          { name: "notes.txt", path: "/h/p/-repo-wt/notes.txt", kind: "file" },
        ],
      }),
    );
    expect(await history.list()).toEqual([
      { sessionId: "u1", ref: "/h/p/-repo-wt/u1.jsonl", mtime: 5, size: 9 },
    ]);
  });

  it("an unreadable project dir fails the list — a partial answer prunes the index", async () => {
    // The store EXISTS; one project dir doesn't read. Degrading it to []
    // made the listing look like those sessions were deleted, and the index
    // prune deletes what the listing omits. A throw reaches the scanner's
    // per-agent catch instead: logged, nothing pruned.
    const history = claudeHistory(
      ctx({}, {
        "~/.claude/projects": [
          { name: "-repo-wt", path: "/h/p/-repo-wt", kind: "dir" },
        ],
        // "/h/p/-repo-wt" deliberately absent → readDir throws.
      }),
    );
    await expect(history.list()).rejects.toThrow();
  });

  it("listing() walks past an unreadable project dir: what read is indexed, the dir is named, the answer is incomplete", async () => {
    const warn = vi.fn();
    const history = claudeHistory(
      ctx(
        {},
        {
          "~/.claude/projects": [
            { name: "-repo-a", path: "/h/p/-repo-a", kind: "dir" },
            { name: "-repo-b", path: "/h/p/-repo-b", kind: "dir" },
          ],
          "/h/p/-repo-a": [
            { name: "u1.jsonl", path: "/h/p/-repo-a/u1.jsonl", kind: "file", size: 9, mtime: 5 },
          ],
          // "/h/p/-repo-b" deliberately absent → readDir throws mid-walk.
        },
        warn,
      ),
    );
    expect(await history.listing!()).toEqual({
      stubs: [
        { sessionId: "u1", ref: "/h/p/-repo-a/u1.jsonl", mtime: 5, size: 9 },
      ],
      complete: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("/h/p/-repo-b");
  });

  it("listing() on an unreadable root answers nothing-read and incomplete — never an empty store", async () => {
    // [] with complete:true would read as "every session deleted" and the
    // host's prune would wipe the agent's whole index.
    const warn = vi.fn();
    const history = claudeHistory(ctx({}, {}, warn));
    expect(await history.listing!()).toEqual({ stubs: [], complete: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("listing() on a readable store answers complete, with list()'s exact stubs", async () => {
    const dirs = {
      "~/.claude/projects": [
        { name: "-repo-a", path: "/h/p/-repo-a", kind: "dir" },
      ],
      "/h/p/-repo-a": [
        { name: "u1.jsonl", path: "/h/p/-repo-a/u1.jsonl", kind: "file", size: 9, mtime: 5 },
      ],
    };
    const history = claudeHistory(ctx({}, dirs));
    const answer = await history.listing!();
    expect(answer.complete).toBe(true);
    expect(answer.stubs).toEqual(await history.list());
  });

  it("describe pulls cwd from the lines and titles by the first REAL user turn — skill/tag preambles don't name a conversation", async () => {
    const history = claudeHistory(ctx({ "/f.jsonl": LINES }, {}));
    expect(await history.describe("/f.jsonl")).toEqual({
      cwd: "/repo/wt",
      title: "fix the auth bug",
      transcriptPath: "/f.jsonl",
    });
  });

  it("titles come from claude's own sessions-index firstPrompt when usable — sparing the full read", async () => {
    const history = claudeHistory(
      ctx(
        {
          "/p/-repo/f.jsonl": LINES,
          "/p/-repo/sessions-index.json": JSON.stringify({
            version: 1,
            entries: [
              { sessionId: "f", firstPrompt: "quick fix for the auth bug" },
            ],
          }),
        },
        {},
      ),
    );
    expect((await history.describe("/p/-repo/f.jsonl")).title).toBe(
      "quick fix for the auth bug",
    );
  });

  it('the index\'s literal "No prompt" placeholder falls through to the full read', async () => {
    const history = claudeHistory(
      ctx(
        {
          "/p/-repo/f.jsonl": LINES,
          "/p/-repo/sessions-index.json": JSON.stringify({
            entries: [{ sessionId: "f", firstPrompt: "No prompt" }],
          }),
        },
        {},
      ),
    );
    expect((await history.describe("/p/-repo/f.jsonl")).title).toBe(
      "fix the auth bug",
    );
  });

  it("a preamble firstPrompt in the index falls through to the full read", async () => {
    const history = claudeHistory(
      ctx(
        {
          "/p/-repo/f.jsonl": LINES,
          "/p/-repo/sessions-index.json": JSON.stringify({
            entries: [{ sessionId: "f", firstPrompt: "/prime" }],
          }),
        },
        {},
      ),
    );
    expect((await history.describe("/p/-repo/f.jsonl")).title).toBe(
      "fix the auth bug",
    );
  });

  it("a pasted absolute path IS a real title — only single-token /commands are preambles", async () => {
    const pathFirst = [
      JSON.stringify({
        type: "user",
        cwd: "/repo",
        message: {
          role: "user",
          content: "/Users/a/Projects/FEEDBACK.md — проанализируй файл",
        },
      }),
    ].join("\n");
    const history = claudeHistory(ctx({ "/f.jsonl": pathFirst }, {}));
    expect((await history.describe("/f.jsonl")).title).toContain("FEEDBACK.md");
  });

  it("isMeta lines are framework noise — never a title, never content", async () => {
    const withMeta = [
      JSON.stringify({
        type: "user",
        isMeta: true,
        cwd: "/repo/wt",
        message: { role: "user", content: "Continue from where you left off." },
      }),
      LINES,
    ].join("\n");
    const history = claudeHistory(ctx({ "/f.jsonl": withMeta }, {}));
    expect((await history.describe("/f.jsonl")).title).toBe("fix the auth bug");
    expect(await history.content("/f.jsonl")).not.toContain("Continue from where");
  });

  it("the store's own summary line outranks the first user turn; the last summary wins", async () => {
    const withSummary = [
      JSON.stringify({ type: "summary", summary: "stale name" }),
      JSON.stringify({ type: "summary", summary: "auth investigation" }),
      LINES,
    ].join("\n");
    const history = claudeHistory(ctx({ "/f.jsonl": withSummary }, {}));
    expect((await history.describe("/f.jsonl")).title).toBe("auth investigation");
  });

  it("content and transcript keep user+assistant turns, skip noise and torn lines", async () => {
    const history = claudeHistory(ctx({ "/f.jsonl": LINES }, {}));
    expect(await history.content("/f.jsonl")).toContain("found it in refresh()");
    const page = await history.transcript("/f.jsonl", { offset: 0, limit: 10 });
    expect(page.map((e) => e.role)).toEqual(["user", "user", "user", "assistant"]);
  });

  it("slash-command envelopes (plain user lines, NOT isMeta) stay out of content and transcript", async () => {
    const withEnvelopes = [
      JSON.stringify({
        type: "user",
        cwd: "/repo/wt",
        message: {
          role: "user",
          content: "<command-message>primo</command-message>\n<command-name>/primo</command-name>",
        },
      }),
      JSON.stringify({
        type: "user",
        cwd: "/repo/wt",
        message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" },
      }),
      LINES,
    ].join("\n");
    const history = claudeHistory(ctx({ "/f.jsonl": withEnvelopes }, {}));
    expect(await history.content("/f.jsonl")).not.toContain("command-message");
    const page = await history.transcript("/f.jsonl", { offset: 0, limit: 10 });
    expect(page.some((e) => e.text.includes("<command-"))).toBe(false);
    expect(page.some((e) => e.text.includes("local-command-stdout"))).toBe(false);
    // The real conversation survives the filter.
    expect(page.map((e) => e.text)).toContain("fix the auth bug");
  });

  it("a fork's sidecar names the branch moment; an original inherits nothing", async () => {
    // The store marks a copy in a .meta.json sidecar beside the transcript
    // (isFork: true). The sidecar carries no timestamp of its own — its
    // mtime IS the branch moment (the file is born at the fork).
    const forked = claudeHistory(
      ctx(
        {
          "/p/-repo/copy.jsonl": LINES,
          "/p/-repo/copy.meta.json": JSON.stringify({
            isFork: true,
            parentAgentId: "orig",
          }),
        },
        {
          "/p/-repo": [
            { name: "copy.meta.json", path: "/p/-repo/copy.meta.json", kind: "file", mtime: 1752900000000 },
          ],
        },
      ),
    );
    await expect(forked.describe("/p/-repo/copy.jsonl")).resolves.toMatchObject({
      title: "fix the auth bug",
      forkedAt: 1752900000000,
    });

    // An original — no sidecar at all, or one that does not claim isFork —
    // must never inherit a copy's badge.
    const plain = claudeHistory(ctx({ "/p/-repo/u.jsonl": LINES }, {}));
    await expect(plain.describe("/p/-repo/u.jsonl")).resolves.not.toHaveProperty(
      "forkedAt",
    );
    const unmarked = claudeHistory(
      ctx(
        {
          "/p/-repo/u.jsonl": LINES,
          "/p/-repo/u.meta.json": JSON.stringify({ agentType: "general" }),
        },
        {},
      ),
    );
    await expect(unmarked.describe("/p/-repo/u.jsonl")).resolves.not.toHaveProperty(
      "forkedAt",
    );
  });
});
