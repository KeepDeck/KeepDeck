import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { fsFileRead } from "@keepdeck/plugin-api/testing";
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

/** Paths whose read came back SHORT, mapped to the file's full length. The
 * answer itself is built by the contract's own double — see
 * `@keepdeck/plugin-api/testing`. */
type ShortReads = Record<string, number>;

function ctx(
  files: Record<string, string>,
  dirs: Record<string, unknown[]>,
  warn: (message: string) => void = vi.fn(),
  short: ShortReads = {},
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
        readFile: async (path: string) =>
          fsFileRead(path, files[path] ?? null, short[path]),
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

  it("an orphaned store file is dropped BY NAME in BOTH enumeration paths", async () => {
    // The CLI moves a colliding task file aside as <id>.orphaned-…jsonl;
    // the enumeration derives the id from the filename, so keeping the
    // row would index an address that never existed. Both roads drop it —
    // a partial walk must not let the garbage ride the older one.
    const dirs = {
      "~/.claude/projects": [
        { name: "-repo-a", path: "/h/p/-repo-a", kind: "dir" },
      ],
      "/h/p/-repo-a": [
        { name: "u1.jsonl", path: "/h/p/-repo-a/u1.jsonl", kind: "file", size: 9, mtime: 5 },
        {
          name: "u2.orphaned-1786650822694-a024affe.jsonl",
          path: "/h/p/-repo-a/u2.orphaned-1786650822694-a024affe.jsonl",
          kind: "file",
          size: 3,
          mtime: 1,
        },
      ],
    };
    const history = claudeHistory(ctx({}, dirs));
    expect(await history.list()).toEqual([
      { sessionId: "u1", ref: "/h/p/-repo-a/u1.jsonl", mtime: 5, size: 9 },
    ]);
    const answer = await history.listing!();
    expect(answer.stubs).toEqual([
      { sessionId: "u1", ref: "/h/p/-repo-a/u1.jsonl", mtime: 5, size: 9 },
    ]);
    expect(answer.complete).toBe(true);
  });

  it("the name filter touches only the orphaned suffix — unusual ids stay", async () => {
    // The drop is BY NAME and the name grammar is claude's, not ours: any
    // .jsonl without the orphaned marker is a session row as far as the
    // enumeration is concerned, whatever its id looks like.
    const dirs = {
      "~/.claude/projects": [
        { name: "-repo-a", path: "/h/p/-repo-a", kind: "dir" },
      ],
      "/h/p/-repo-a": [
        { name: "weird ID.jsonl", path: "/h/p/-repo-a/weird ID.jsonl", kind: "file", size: 1, mtime: 1 },
        { name: "UPPER-Case.jsonl", path: "/h/p/-repo-a/UPPER-Case.jsonl", kind: "file", size: 1, mtime: 2 },
      ],
    };
    const history = claudeHistory(ctx({}, dirs));
    expect((await history.list()).map((s) => s.sessionId).sort()).toEqual([
      "UPPER-Case",
      "weird ID",
    ]);
  });

  it("a transcript with agent-name in its head and HUMAN turns is described — it is a conversation, not a task copy", async () => {
    // GUARD against a rejected marker: `agent-name` in the first records
    // was once read as "background task's context copy" and used to hide
    // files. Measurement killed it: a five-day 58MB conversation of a
    // person who ALSO had background work carries the same head — the
    // marker says "this conversation was agent-run", not "this file is a
    // copy". Hiding on it erased real conversations forever. A task's
    // transfer copy does stay in the list as an extra row (a named,
    // accepted flaw); the only true discriminator is cross-file verbatim
    // comparison, deliberately out of scope.
    const agentRunHead = [
      JSON.stringify({ type: "ai-title", aiTitle: "kernel work", sessionId: "u" }),
      JSON.stringify({ type: "agent-name", agentName: "kernel work", sessionId: "u" }),
      JSON.stringify({ type: "mode", mode: "normal", sessionId: "u" }),
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "u" }),
      JSON.stringify({
        type: "user",
        cwd: "/repo",
        message: { role: "user", content: "fix the audio stutter" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
      }),
    ].join("\n");
    const history = claudeHistory(ctx({ "/u.jsonl": agentRunHead }, {}));
    await expect(history.describe("/u.jsonl")).resolves.toMatchObject({
      cwd: "/repo",
      title: "fix the audio stutter",
    });
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

  it("a page cut short by the cap says so in bytes", async () => {
    // The other half of the flag's journey. It has ridden in from Rust since
    // before this stage, and until the shortfall landed nobody read it — the
    // plugins all wrote `file.text ?? ""` and moved on. This is the assertion
    // that the reading now speaks about itself, in the measure a file has.
    const history = claudeHistory(
      ctx({ "/f.jsonl": LINES }, {}, vi.fn(), { "/f.jsonl": 9_000_000 }),
    );
    const page = await history.transcriptPage!("/f.jsonl", { offset: 0, limit: 10 });
    expect(page.shortfall).toEqual([
      {
        kind: "bytes",
        size: 9_000_000,
        readBytes: new TextEncoder().encode(LINES).length,
      },
    ]);
  });

  it("a page that read everything carries no shortfall at all", async () => {
    // Absence is the ONLY spelling of "nothing was missed" — an empty array
    // would be a second one, and two spellings of one truth drift apart.
    const history = claudeHistory(ctx({ "/f.jsonl": LINES }, {}));
    const page = await history.transcriptPage!("/f.jsonl", { offset: 0, limit: 10 });
    expect(page.shortfall).toBeUndefined();
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

  it("a `.meta.json` sidecar beside a transcript is subagent machinery, not a session fork marker", async () => {
    // The `.meta.json` sidecars claude writes exist only inside the
    // subagents' service folders, and their `isFork` names a SUBAGENT of
    // type fork — a different fork than KeepDeck's session copy. The
    // plugin must not report a `forkedAt` from them (or anything else):
    // describe answers carry no fork field at all.
    const history = claudeHistory(
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
    await expect(history.describe("/p/-repo/copy.jsonl")).resolves.not.toHaveProperty(
      "forkedAt",
    );
  });
});
