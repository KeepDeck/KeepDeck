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
  files: Record<string, string | Uint8Array>,
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

  it("lists ONE stub per session — its newest file, a compressed or reverted one included", async () => {
    // A resumed session can leave an older file under its id, and a revert
    // starts a `<thread>_<segment>` file; two stubs under one id would take
    // turns as the index's single row. A session codex has compressed stays
    // listed (its .zst), rather than reading as deleted and being pruned.
    const SID = "019f7af4-f57f-7dc3-ac52-6e1bb90dceec";
    const OLD = "019f7000-0000-7000-8000-00000000000a";
    const old = `rollout-2026-07-01T10-00-00-${SID}.jsonl`;
    const reverted = `rollout-2026-07-19T16-27-47-${SID}_019f7af5-0000-7000-8000-000000000001.jsonl`;
    const compressed = `rollout-2026-07-02T10-00-00-${OLD}.jsonl.zst`;
    const history = codexHistory(
      ctx({}, {
        "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
        "/s/2026": [{ name: "07", path: "/s/2026/07", kind: "dir" }],
        "/s/2026/07": [{ name: "01", path: "/s/2026/07/01", kind: "dir" }],
        // The newest file listed FIRST: whichever comes last must not win.
        "/s/2026/07/01": [
          { name: reverted, path: `/s/2026/07/01/${reverted}`, kind: "file", size: 5, mtime: 9 },
          { name: old, path: `/s/2026/07/01/${old}`, kind: "file", size: 3, mtime: 1 },
          { name: compressed, path: `/s/2026/07/01/${compressed}`, kind: "file", size: 2, mtime: 4 },
        ],
      }),
    );
    expect(await history.list()).toEqual([
      { sessionId: SID, ref: `/s/2026/07/01/${reverted}`, mtime: 9, size: 5 },
      { sessionId: OLD, ref: `/s/2026/07/01/${compressed}`, mtime: 4, size: 2 },
    ]);
  });

  describe("a fork's conversation (task-588)", () => {
    // codex 0.163+ forks a paginated thread by REFERENCE: the fork's first
    // record names its source and the byte its inherited prefix ends at.
    const SOURCE = "11111111-1111-4111-8111-111111111111";
    const FORK = "22222222-2222-4222-8222-222222222222";
    const line = (record: unknown) => `${JSON.stringify(record)}\n`;
    const said = (role: "user" | "assistant", text: string) => ({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    const inherited =
      line({ type: "session_meta", payload: { id: SOURCE, cwd: "/repo" } }) +
      line(said("user", "before the fork")) +
      line(said("assistant", "answered"));
    // Written to the source AFTER the fork: not the fork's history.
    const source = inherited + line(said("user", "the source went on"));
    const forkOf = (sourceId: string) =>
      line({
        type: "session_meta",
        payload: {
          id: FORK,
          cwd: "/repo/wt",
          history_base: {
            thread_id: sourceId,
            end_ordinal_exclusive: 3,
            end_byte_offset: new TextEncoder().encode(inherited).length,
          },
        },
      }) + line(said("user", "after the fork"));
    const sourceName = `rollout-2026-01-01T00-00-00-${SOURCE}.jsonl`;
    const forkName = `rollout-2026-01-02T00-00-00-${FORK}.jsonl`;
    const store = (fork: string, withSource = true) =>
      codexHistory(
        ctx(
          { ...(withSource ? { [`/s/${sourceName}`]: source } : {}), [`/s/${forkName}`]: fork },
          {
            "~/.codex/sessions": [
              ...(withSource
                ? [{ name: sourceName, path: `/s/${sourceName}`, kind: "file" as const, size: source.length, mtime: 1 }]
                : []),
              { name: forkName, path: `/s/${forkName}`, kind: "file" as const, size: fork.length, mtime: 2 },
            ],
          },
        ),
      );
    const texts = async (history: ReturnType<typeof store>) =>
      (await present(history.transcriptPage, "the transcript page")(`/s/${forkName}`, { offset: 0, limit: 50 })).entries.map(
        (entry) => entry.text,
      );

    it("reads the source's inherited prefix, then the fork's own — and nothing the source said later", async () => {
      const history = store(forkOf(SOURCE));
      expect(await texts(history)).toEqual(["before the fork", "answered", "after the fork"]);
      expect(await history.content(`/s/${forkName}`)).toContain("before the fork");
      expect(await history.content(`/s/${forkName}`)).not.toContain("the source went on");
    });

    it("describes the fork by itself: where it runs, and what it was asked first", async () => {
      expect(await store(forkOf(SOURCE)).describe(`/s/${forkName}`)).toMatchObject({
        cwd: "/repo/wt",
        title: "after the fork",
      });
    });

    it("reads what it has when the source is gone", async () => {
      expect(await texts(store(forkOf(SOURCE), false))).toEqual(["after the fork"]);
    });
  });

  it("describes a compressed rollout as read NOTHING — so the index keeps what it knew", async () => {
    // zstd's magic and a frame: not text, not a byte of it readable here.
    // An empty describe would read as "a session with nothing in it"; the
    // bytes mark at zero is what keeps the indexed facts (task-417).
    const zst = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x01, 0x00, 0x00, 0x7b]);
    const history = codexHistory(ctx({ "/r.jsonl.zst": zst }, {}));
    expect(await history.describe("/r.jsonl.zst")).toEqual({
      cwd: "",
      title: undefined,
      transcriptPath: "/r.jsonl.zst",
      shortfall: [{ kind: "bytes", size: zst.length, readBytes: 0 }],
    });
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
    // its page reads the whole conversation from where it was asked and
    // hands the mark on — so the store here is one the budget cut short, at
    // no cost of bytes.
    const turn = (text: string) => ({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    const store = fakeSessionStore([turn("t0"), turn("t1"), turn("t2")], "budget", 9_000_000);
    const history = codexHistory({
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      services: { fs: { readDir: async () => [] }, sessionStore: store },
    });

    const page = await present(history.transcriptPage, "the transcript page")("/r.jsonl", {
      offset: 1,
      limit: 10,
    });

    // Short of the limit — how the viewer's pagination learns it reached the end.
    expect(page.entries.map((entry) => entry.text)).toEqual(["t1", "t2"]);
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
