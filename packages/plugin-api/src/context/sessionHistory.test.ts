import { describe, expect, it, vi } from "vitest";
import {
  fileStub,
  readStoreDir,
  sessionHistory,
  type SessionStore,
} from "./sessionHistory";
import type { PluginFs } from "./services";

const stub = (id: string) => ({ sessionId: id, ref: `/s/${id}`, mtime: 1, size: 2 });
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A store whose enumeration is scripted: what it finds, which parts will
 * not read, and whether its root throws. */
function store(opts: {
  stubs?: ReturnType<typeof stub>[];
  unreadable?: string[];
  root?: Error;
} = {}): SessionStore {
  return {
    async enumerate(unreadable) {
      if (opts.root) throw opts.root;
      for (const part of opts.unreadable ?? []) unreadable(part, new Error("EACCES"));
      return opts.stubs ?? [];
    },
    describe: async () => ({ cwd: "/repo" }),
    content: async () => "text",
    readPage: async (_ref, page) => ({
      entries: [{ role: "user", text: `page ${page.offset}` }],
      shortfall: [{ kind: "rows", returned: 1 }],
    }),
  };
}

describe("sessionHistory — list, the strict contract", () => {
  it("answers the whole store", async () => {
    expect(await sessionHistory("x", log(), store({ stubs: [stub("a")] })).list()).toEqual([stub("a")]);
  });

  it("reads a store that is not there as empty: the agent never ran here", async () => {
    expect(await sessionHistory("x", log(), store({ root: new Error("ENOENT") })).list()).toEqual([]);
  });

  it("refuses a store that read only in part, naming the parts", async () => {
    // It cannot say "partial": the stubs that did arrive would be read as the
    // whole store, and everything missing pruned from the index as gone.
    await expect(
      sessionHistory("x", log(), store({ stubs: [stub("a")], unreadable: ["/s/2026"] })).list(),
    ).rejects.toThrow("x: 1 part(s) of the store unreadable (/s/2026) — use listing()");
  });
});

describe("sessionHistory — listing, the partial-tolerant contract", () => {
  it("is complete when every part read", async () => {
    expect(await sessionHistory("x", log(), store({ stubs: [stub("a")] })).listing!()).toEqual({
      stubs: [stub("a")],
      complete: true,
    });
  });

  it("keeps what read, names what did not, and says it is incomplete", async () => {
    const l = log();
    const answer = await sessionHistory("x", l, store({ stubs: [stub("a")], unreadable: ["/s/2026"] })).listing!();
    expect(answer).toEqual({ stubs: [stub("a")], complete: false });
    expect(l.warn).toHaveBeenCalledWith("x: partial listing — /s/2026 unreadable (EACCES)");
  });

  it("never reads a root refusal as an empty store", async () => {
    // [] with complete:true would read as "every session deleted", and the
    // host's prune would wipe the agent's whole index.
    const l = log();
    const answer = await sessionHistory("x", l, store({ root: new Error("EACCES") })).listing!();
    expect(answer).toEqual({ stubs: [], complete: false });
    expect(l.warn).toHaveBeenCalledWith("x: store root unreadable (EACCES) — nothing enumerated");
  });
});

describe("sessionHistory — reading", () => {
  it("derives the legacy transcript from the one page reading", async () => {
    const history = sessionHistory("x", log(), store());
    const page = { offset: 3, limit: 10 };
    expect(await history.transcriptPage!("r", page)).toEqual({
      entries: [{ role: "user", text: "page 3" }],
      shortfall: [{ kind: "rows", returned: 1 }],
    });
    expect(await history.transcript("r", page)).toEqual([{ role: "user", text: "page 3" }]);
  });

  it("passes describe and content through to the store", async () => {
    const history = sessionHistory("x", log(), store());
    expect(await history.describe("r")).toEqual({ cwd: "/repo" });
    expect(await history.content("r")).toBe("text");
  });
});

describe("store helpers", () => {
  it("readStoreDir returns the entries, or reports the directory and answers null", async () => {
    const entries = [{ name: "a", path: "/d/a", kind: "file" as const }];
    const fs = {
      readDir: async (path: string) => {
        if (path === "/bad") throw new Error("EACCES");
        return entries;
      },
    } as unknown as PluginFs;
    const unreadable = vi.fn();
    expect(await readStoreDir(fs, "/d", unreadable)).toBe(entries);
    expect(await readStoreDir(fs, "/bad", unreadable)).toBeNull();
    expect(unreadable).toHaveBeenCalledWith("/bad", expect.any(Error));
  });

  it("fileStub takes the file as the ref and its stat as the fingerprint", () => {
    expect(fileStub("s1", { name: "x", path: "/p/x", kind: "file", mtime: 5, size: 9 })).toEqual({
      sessionId: "s1", ref: "/p/x", mtime: 5, size: 9,
    });
    expect(fileStub("s1", { name: "x", path: "/p/x", kind: "file" })).toMatchObject({ mtime: 0, size: 0 });
  });
});
