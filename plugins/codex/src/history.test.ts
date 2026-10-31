import { describe, expect, it, vi } from "vitest";
import { createSessionStore, type FsEntry } from "@keepdeck/plugin-api";
import { present, fsStore, fakeSessionStore } from "@keepdeck/plugin-api/testing";
import { codexHistory, type HistoryPorts } from "./history";

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

function ctx(
  files: Record<string, string>,
  dirs: Record<string, FsEntry[]>,
  warn: (message: string) => void = vi.fn(),
): HistoryPorts {
  // A rollout is read a WINDOW at a time now, so the double has to serve
  // windows; `dirs` stays hand-built, because these tests are about what the
  // enumeration does with listings a real directory cannot pose.
  const fs = fsStore(files);
  return {
    log: { warn, info: vi.fn(), error: vi.fn() },
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
    const answer = await present(history.listing, "the session listing")();
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
    expect(await present(history.listing, "the session listing")()).toEqual({ stubs: [], complete: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("listing() on a readable tree answers complete, with list()'s exact stubs", async () => {
    const name = "rollout-2026-07-19T16-27-47-019f7af4-f57f-7dc3-ac52-6e1bb90dceec.jsonl";
    const dirs: Record<string, FsEntry[]> = {
      "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
      "/s/2026": [{ name: "07", path: "/s/2026/07", kind: "dir" }],
      "/s/2026/07": [{ name: "19", path: "/s/2026/07/19", kind: "dir" }],
      "/s/2026/07/19": [
        { name, path: `/s/2026/07/19/${name}`, kind: "file", size: 3, mtime: 7 },
      ],
    };
    const history = codexHistory(ctx({}, dirs));
    const answer = await present(history.listing, "the session listing")();
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

  it("a page cut short by the budget says so in bytes", async () => {
    // Where the budget stops a read, and the mark that stop leaves, are the
    // host's (sessionRead.test.ts, sessionWalk.test.ts). This plugin's part:
    // its page reads the whole conversation and hands the mark on — so the
    // store here is one the budget cut short, at no cost of bytes.
    const turn = {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] },
    };
    const store = fakeSessionStore([turn, turn, turn], "budget", 9_000_000);
    const history = codexHistory({
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      services: { fs: { readDir: async () => [] }, sessionStore: store },
    });

    const page = await present(history.transcriptPage, "the transcript page")("/r.jsonl", {
      offset: 0,
      limit: 10,
    });

    // Short of the limit — how the viewer's pagination learns it reached the end.
    expect(page.entries).toHaveLength(3);
    expect(page.shortfall).toEqual([{ kind: "bytes", size: 9_000_000, readBytes: 10 }]);
    expect(store.scopes).toEqual(["whole"]);
  });

  it("counts a line that is no rollout record, as a shortfall, and reads the rest as before", async () => {
    // A payload that is not an object is no record of this format either.
    const odd = `"stray"\n${JSON.stringify({ type: "response_item", payload: "flat" })}\n`;
    const clean = codexHistory(ctx({ "/r.jsonl": LINES }, {}));
    const stray = codexHistory(ctx({ "/r.jsonl": odd + LINES }, {}));
    const read = (history: typeof clean) =>
      present(history.transcriptPage, "the transcript page")("/r.jsonl", { offset: 0, limit: 10 });
    const [before, after] = [await read(clean), await read(stray)];
    expect(before.entries.length).toBeGreaterThan(0);
    expect(after.entries).toEqual(before.entries);
    expect(after.shortfall).toEqual([{ kind: "parts", unreadableParts: 2 }]);
  });

  it("a page that read everything carries no shortfall at all", async () => {
    // Absence is the ONLY spelling of "nothing was missed"; an empty array
    // would be a second one, and two spellings of one truth drift apart.
    const history = codexHistory(ctx({ "/r.jsonl": LINES }, {}));
    const page = await present(history.transcriptPage, "the transcript page")("/r.jsonl", { offset: 0, limit: 10 });
    expect(page.shortfall).toBeUndefined();
  });

  it("a head without a newline is taken whole, not slice(0,-1)-mangled", async () => {
    const history = codexHistory(ctx({ "/r.jsonl": META }, {}));
    expect((await history.describe("/r.jsonl")).cwd).toBe("/repo/wt");
  });

  it("parses only user/assistant message items", async () => {
    // Through the contract rather than through an exported parser: what the
    // dialect means is only observable in what a reading returns.
    const history = codexHistory(ctx({ "/r.jsonl": LINES }, {}));
    const page = await history.transcript("/r.jsonl", { offset: 0, limit: 10 });
    expect(page.map((t) => t.role)).toEqual(["user", "user", "assistant"]);
  });
});
