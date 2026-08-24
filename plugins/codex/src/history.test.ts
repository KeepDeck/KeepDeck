import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { codexHistory, parseRollout } from "./history";

const META = JSON.stringify({
  type: "session_meta",
  payload: { id: "019f-uuid", cwd: "/repo/wt" },
});
const LINES = [
  META,
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "plumbing" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions\nblob" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "rename the rail" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done, renamed" }],
    },
  }),
].join("\n");

/** Paths whose read came back SHORT, mapped to the file's full length — the
 * double could not express falling short at all before this: `truncated` was
 * hard-coded false and `readBytes` was missing outright, hidden by the cast to
 * `PluginContext`. */
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
        readFile: async (path: string) => {
          const text = files[path] ?? null;
          // BYTES, not characters — see the note in claude's double: counting
          // code units would describe a different world for any non-ASCII
          // fixture, and the assertion would not notice.
          const readBytes = text === null ? 0 : new TextEncoder().encode(text).length;
          const full = short[path];
          return {
            path,
            text,
            isBinary: false,
            size: full ?? readBytes,
            readBytes,
            truncated: full !== undefined,
          };
        },
      },
    },
  } as unknown as PluginContext;
}

describe("codex history", () => {
  it("walks the date tree and keys stubs by the filename uuid", async () => {
    const name = "rollout-2026-07-19T16-27-47-019f7af4-f57f-7dc3-ac52-6e1bb90dceec.jsonl";
    const history = codexHistory(
      ctx({}, {
        "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
        "/s/2026": [{ name: "07", path: "/s/2026/07", kind: "dir" }],
        "/s/2026/07": [{ name: "19", path: "/s/2026/07/19", kind: "dir" }],
        "/s/2026/07/19": [
          { name, path: `/s/2026/07/19/${name}`, kind: "file", size: 3, mtime: 7 },
        ],
      }),
    );
    expect(await history.list()).toEqual([
      {
        sessionId: "019f7af4-f57f-7dc3-ac52-6e1bb90dceec",
        ref: `/s/2026/07/19/${name}`,
        mtime: 7,
        size: 3,
      },
    ]);
  });

  it("an unreadable date partition fails the walk — a partial answer prunes the index", async () => {
    const history = codexHistory(
      ctx({}, {
        "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
        "/s/2026": [{ name: "07", path: "/s/2026/07", kind: "dir" }],
        // "/s/2026/07" deliberately absent → readDir throws mid-walk. A []
        // here looked like every session under it was deleted, and the index
        // prune acted on that.
      }),
    );
    await expect(history.list()).rejects.toThrow();
  });

  it("listing() walks past an unreadable partition at ANY depth — the skip lives inside the recursion", async () => {
    const warn = vi.fn();
    const name = "rollout-2026-07-19T16-27-47-019f7af4-f57f-7dc3-ac52-6e1bb90dceec.jsonl";
    const history = codexHistory(
      ctx(
        {},
        {
          "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
          "/s/2026": [
            { name: "07", path: "/s/2026/07", kind: "dir" },
            { name: "08", path: "/s/2026/08", kind: "dir" },
          ],
          "/s/2026/07": [{ name: "19", path: "/s/2026/07/19", kind: "dir" }],
          "/s/2026/07/19": [
            { name, path: `/s/2026/07/19/${name}`, kind: "file", size: 3, mtime: 7 },
          ],
          // "/s/2026/08" deliberately absent → readDir throws at depth 2.
        },
        warn,
      ),
    );
    const answer = await history.listing!();
    expect(answer.complete).toBe(false);
    expect(answer.stubs.map((s) => s.sessionId)).toEqual([
      "019f7af4-f57f-7dc3-ac52-6e1bb90dceec",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("/s/2026/08");
  });

  it("listing() on an unreadable root answers nothing-read and incomplete — never an empty store", async () => {
    const warn = vi.fn();
    const history = codexHistory(ctx({}, {}, warn));
    expect(await history.listing!()).toEqual({ stubs: [], complete: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("listing() on a readable tree answers complete, with list()'s exact stubs", async () => {
    const name = "rollout-2026-07-19T16-27-47-019f7af4-f57f-7dc3-ac52-6e1bb90dceec.jsonl";
    const dirs = {
      "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
      "/s/2026": [{ name: "07", path: "/s/2026/07", kind: "dir" }],
      "/s/2026/07": [{ name: "19", path: "/s/2026/07/19", kind: "dir" }],
      "/s/2026/07/19": [
        { name, path: `/s/2026/07/19/${name}`, kind: "file", size: 3, mtime: 7 },
      ],
    };
    const history = codexHistory(ctx({}, dirs));
    const answer = await history.listing!();
    expect(answer.complete).toBe(true);
    expect(answer.stubs).toEqual(await history.list());
  });

  it("describe reads the session_meta cwd; titles skip instruction blobs", async () => {
    const history = codexHistory(ctx({ "/r.jsonl": LINES }, {}));
    expect(await history.describe("/r.jsonl")).toEqual({
      cwd: "/repo/wt",
      title: "rename the rail",
      transcriptPath: "/r.jsonl",
    });
  });

  it("a page cut short by the cap says so in bytes", async () => {
    // The flag has ridden in from Rust since before this stage and nobody read
    // it — every plugin wrote `file.text ?? ""` and moved on. This is the
    // assertion that the reading speaks about itself, in the measure a file
    // has.
    const history = codexHistory(
      ctx({ "/r.jsonl": LINES }, {}, vi.fn(), { "/r.jsonl": 9_000_000 }),
    );
    const page = await history.transcriptPage!("/r.jsonl", { offset: 0, limit: 10 });
    expect(page.shortfall).toEqual([
      {
        kind: "bytes",
        size: 9_000_000,
        readBytes: new TextEncoder().encode(LINES).length,
      },
    ]);
  });

  it("a page that read everything carries no shortfall at all", async () => {
    // Absence is the ONLY spelling of "nothing was missed"; an empty array
    // would be a second one, and two spellings of one truth drift apart.
    const history = codexHistory(ctx({ "/r.jsonl": LINES }, {}));
    const page = await history.transcriptPage!("/r.jsonl", { offset: 0, limit: 10 });
    expect(page.shortfall).toBeUndefined();
  });

  it("a head without a newline is taken whole, not slice(0,-1)-mangled", async () => {
    const history = codexHistory(ctx({ "/r.jsonl": META }, {}));
    expect((await history.describe("/r.jsonl")).cwd).toBe("/repo/wt");
  });

  it("parses only user/assistant message items", () => {
    const turns = parseRollout(LINES);
    expect(turns.map((t) => t.role)).toEqual(["user", "user", "assistant"]);
  });
});
