import { describe, expect, it, vi } from "vitest";
import type { FsFile, PluginFs } from "./services.ts";
import {
  createSessionStore,
  jsonl,
  type ReadBudget,
  type SessionCursor,
} from "./sessionRead.ts";
import { createJsonlReader } from "./sessionReadJsonl.ts";

/**
 * A filesystem the size of a variable, honouring the same window contract the
 * real one does: a read starts at `offset`, stops at the smaller of the
 * caller's `maxBytes` and the host's own ceiling, drops a multi-byte
 * character the window cut in half, and reports where it actually stopped.
 *
 * `ceiling` is the point of it. The contract says the host clamps a read to
 * its OWN ceiling, so a tiny one is a legitimate host — and it puts a window
 * boundary every few bytes, which is where this reader's whole difficulty
 * lives. The alternative, fixtures larger than the real 256 KB window, would
 * test the same boundary once and cost a megabyte to do it.
 */
function fakeFs(
  files: Record<string, string | Uint8Array>,
  ceiling = 8 * 1024 * 1024,
): PluginFs {
  return {
    readDir: async () => [],
    watch: () => ({ dispose() {} }),
    readFile: async (path, opts): Promise<FsFile> => {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : content;
      const size = bytes.length;
      const offset = opts?.offset ?? 0;
      const window = bytes.subarray(
        offset,
        offset + Math.min(opts?.maxBytes ?? 1024 * 1024, ceiling),
      );
      const truncated = size > offset + window.length;
      const keep = truncated ? withoutDanglingTail(window) : window.length;
      const text = decode(window.subarray(0, keep));
      return {
        path,
        text,
        isBinary: text === null,
        size,
        truncated: size > offset + keep,
        readBytes: text === null ? window.length : keep,
      };
    },
  };
}

/** How much of a window is safe to decode: bytes belonging to a character
 * whose remainder the window cut off are ours to drop, and they come back on
 * the next read. */
function withoutDanglingTail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const lead = bytes[bytes.length - back];
    if ((lead & 0xc0) === 0x80) continue; // a continuation byte, keep walking
    const needs =
      lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    return back < needs ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** `null` for a window that is not text — the shape a NUL byte or a broken
 * encoding arrives in. */
function decode(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const NARROW: ReadBudget = { maxPayloadBytes: 64 * 1024 };

/** Read everything a store has, collecting the records. */
async function readAll(
  fs: PluginFs,
  path: string,
  budget: ReadBudget = NARROW,
  from?: SessionCursor,
) {
  const seen: unknown[] = [];
  const outcome = await createJsonlReader(fs).pull({ path, from }, budget, (r) => {
    seen.push(r);
    return "more";
  });
  return { seen, outcome };
}

/** A store of `count` records, each padded to a fixed width so the caller
 * knows exactly where in a record any given byte falls. */
function store(count: number, pad = "x", trailingNewline = true): string {
  const lines = Array.from(
    { length: count },
    (_, i) => `{"i":${i},"pad":"${pad.repeat(6)}"}`,
  );
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

describe("jsonl reader", () => {
  it("delivers a record the window boundary cut in half", async () => {
    // A seven-byte ceiling puts a boundary inside almost every record.
    const fs = fakeFs({ "/s.jsonl": store(20) }, 7);

    const { seen, outcome } = await readAll(fs, "/s.jsonl");

    expect(seen).toHaveLength(20);
    expect(seen[0]).toEqual({ i: 0, pad: "xxxxxx" });
    expect(seen[19]).toEqual({ i: 19, pad: "xxxxxx" });
    expect(outcome.stopped).toBe("exhausted");
  });

  it("delivers a record a multi-byte character straddles", async () => {
    // Two-byte padding with an odd ceiling: every window edge that lands in
    // the padding lands INSIDE a character, not between two.
    const fs = fakeFs({ "/s.jsonl": store(20, "Д") }, 7);

    const { seen, outcome } = await readAll(fs, "/s.jsonl");

    expect(seen).toHaveLength(20);
    expect(seen[7]).toEqual({ i: 7, pad: "ДДДДДД" });
    expect(outcome.stopped).toBe("exhausted");
  });

  it("delivers the last record of a store that ends without a newline", async () => {
    // A live session's newest turn is exactly this: written, not yet
    // terminated. Treating the final piece as an unfinished line would drop
    // the turn the user just took.
    const fs = fakeFs({ "/s.jsonl": store(3, "x", false) }, 7);

    const { seen } = await readAll(fs, "/s.jsonl");

    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual({ i: 2, pad: "xxxxxx" });
  });

  it("skips a line it cannot decode and keeps reading", async () => {
    const fs = fakeFs({
      "/s.jsonl": `{"i":0}\n{"i":1\n\n{"i":2}\n`,
    });

    const { seen, outcome } = await readAll(fs, "/s.jsonl");

    expect(seen).toEqual([{ i: 0 }, { i: 2 }]);
    expect(outcome.stopped).toBe("exhausted");
  });

  it("stops on the budget and says the data is short", async () => {
    const text = store(200);
    const fs = fakeFs({ "/s.jsonl": text }, 64);

    const { seen, outcome } = await readAll(fs, "/s.jsonl", {
      maxPayloadBytes: 500,
    });

    expect(outcome.stopped).toBe("budget");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(200);
    expect(outcome.sourceBytes).toBe(new TextEncoder().encode(text).length);
    expect(outcome.next).toBeDefined();
  });

  it("stops on a single record larger than the whole budget", async () => {
    // The record never completes inside the budget, so the read has nothing
    // to hand over — and must say so rather than growing its buffer until
    // the record ends.
    const fs = fakeFs({ "/s.jsonl": `{"pad":"${"x".repeat(5000)}"}\n` }, 64);

    const { seen, outcome } = await readAll(fs, "/s.jsonl", {
      maxPayloadBytes: 500,
    });

    expect(seen).toHaveLength(0);
    expect(outcome.stopped).toBe("budget");
  });

  it('stops where the consumer said "enough", and not on the budget', async () => {
    // The distinction the four states exist for: this read is COMPLETE for
    // its purpose, and a mark of incompleteness here would be a lie.
    const fs = fakeFs({ "/s.jsonl": store(50) });
    const seen: unknown[] = [];

    const outcome = await createJsonlReader(fs).pull(
      { path: "/s.jsonl" },
      NARROW,
      (record) => {
        seen.push(record);
        return seen.length === 3 ? "enough" : "more";
      },
    );

    expect(seen).toHaveLength(3);
    expect(outcome.stopped).toBe("satisfied");
    expect(outcome.next).toBeDefined();
  });

  it("resumes from the cursor with no record repeated or lost", async () => {
    const fs = fakeFs({ "/s.jsonl": store(40) }, 7);
    const first: unknown[] = [];
    const head = await createJsonlReader(fs).pull(
      { path: "/s.jsonl" },
      NARROW,
      (record) => {
        first.push(record);
        return first.length === 9 ? "enough" : "more";
      },
    );

    const { seen: rest, outcome } = await readAll(
      fs,
      "/s.jsonl",
      NARROW,
      head.next,
    );

    expect([...first, ...rest]).toEqual((await readAll(fs, "/s.jsonl")).seen);
    expect(outcome.stopped).toBe("exhausted");
  });

  it("offers no cursor once the store is exhausted", async () => {
    // A loop that resumes while a cursor is offered must terminate; a cursor
    // handed out at the end would have it reading emptiness forever.
    const fs = fakeFs({ "/s.jsonl": store(3) });

    const { outcome } = await readAll(fs, "/s.jsonl");

    expect(outcome.stopped).toBe("exhausted");
    expect(outcome.next).toBeUndefined();
  });

  it("reports a store that shrank under the cursor as changed", async () => {
    const files: Record<string, string> = { "/s.jsonl": store(40) };
    const fs = fakeFs(files);
    const head: unknown[] = [];
    const first = await createJsonlReader(fs).pull(
      { path: "/s.jsonl" },
      NARROW,
      (record) => {
        head.push(record);
        return head.length === 5 ? "enough" : "more";
      },
    );

    // Rewritten, not appended to: what the cursor points at is somebody
    // else's byte now.
    files["/s.jsonl"] = store(2);
    const { seen, outcome } = await readAll(fs, "/s.jsonl", NARROW, first.next);

    expect(outcome.stopped).toBe("changed");
    expect(seen).toHaveLength(0);
  });

  it("keeps resuming when the store merely grew", async () => {
    // The normal case for a live session, and the one a cruder check would
    // confuse with a rewrite.
    const files: Record<string, string> = { "/s.jsonl": store(5) };
    const fs = fakeFs(files);
    const head: unknown[] = [];
    const first = await createJsonlReader(fs).pull(
      { path: "/s.jsonl" },
      NARROW,
      (record) => {
        head.push(record);
        return head.length === 2 ? "enough" : "more";
      },
    );

    files["/s.jsonl"] = store(9);
    const { seen, outcome } = await readAll(fs, "/s.jsonl", NARROW, first.next);

    expect(outcome.stopped).toBe("exhausted");
    expect(seen).toHaveLength(7);
  });

  it("treats a cursor it cannot read as a store that changed", async () => {
    // A cursor persisted by an older shape of this reader. "Start over" is
    // already the right instruction, so version skew needs no state of its
    // own.
    const fs = fakeFs({ "/s.jsonl": store(3) });

    const { outcome } = await readAll(
      fs,
      "/s.jsonl",
      NARROW,
      "j0:12:34" as SessionCursor,
    );

    expect(outcome.stopped).toBe("changed");
  });

  it("reports a window that is not text as unreadable, not as the end", async () => {
    // `exhausted` would claim the conversation ended here; it did not — we
    // simply cannot read further.
    const bytes = new Uint8Array([...new TextEncoder().encode('{"i":0}\n'), 0, 1, 2]);
    const fs = fakeFs({ "/s.jsonl": bytes });

    const { outcome } = await readAll(fs, "/s.jsonl");

    expect(outcome.stopped).toBe("unreadable");
  });
});

describe("session store", () => {
  it("routes a format to its reader and hands back the records", async () => {
    const fs = fakeFs({ "/s.jsonl": store(4) });
    const seen: { i: number }[] = [];

    const outcome = await createSessionStore(fs).read(
      jsonl<{ i: number }>(),
      { path: "/s.jsonl" },
      (record) => {
        seen.push(record);
        return "more";
      },
    );

    expect(seen.map((r) => r.i)).toEqual([0, 1, 2, 3]);
    expect(outcome.stopped).toBe("exhausted");
  });

  it("refuses a format it has no reader for", async () => {
    const fs = fakeFs({});
    const unknownFormat = { id: "parquet" };

    await expect(
      createSessionStore(fs).read(unknownFormat, {}, () => "more"),
    ).rejects.toThrow(/parquet/);
  });

  it("reads through the fs it was given, and no other", async () => {
    // The reach of the service is the reach of the caller's own `fs` — which
    // is what makes it need no capability of its own.
    const fs = fakeFs({ "/s.jsonl": store(2) });
    const readFile = vi.spyOn(fs, "readFile");

    await createSessionStore(fs).read(jsonl(), { path: "/s.jsonl" }, () => "more");

    expect(readFile).toHaveBeenCalled();
  });
});
