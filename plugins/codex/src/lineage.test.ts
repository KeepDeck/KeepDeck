import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "@keepdeck/plugin-api";
import { fsStore } from "@keepdeck/plugin-api/testing";
import { historyBaseOf, lineageOf } from "./lineage";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const meta = (id: string, base?: { thread_id: string; end_byte_offset: number }) =>
  `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/repo", ...(base ? { history_base: base } : {}) } })}\n`;

describe("historyBaseOf", () => {
  it("reads what a fork's opening record says it inherited", () => {
    expect(
      historyBaseOf({
        type: "session_meta",
        payload: { id: B, history_base: { thread_id: A, end_ordinal_exclusive: 2, end_byte_offset: 531 } },
      }),
    ).toEqual({ rolloutId: A, endByte: 531 });
  });

  it("is nothing for a session that inherited nothing, another record, or a base it cannot trust", () => {
    expect(historyBaseOf({ type: "session_meta", payload: { id: A } })).toBeNull();
    expect(historyBaseOf({ type: "response_item", payload: { history_base: { thread_id: A, end_byte_offset: 1 } } })).toBeNull();
    for (const base of [{ thread_id: A }, { thread_id: A, end_byte_offset: -1 }, { thread_id: 7, end_byte_offset: 1 }, null]) {
      expect(historyBaseOf({ type: "session_meta", payload: { id: B, history_base: base } }), JSON.stringify(base)).toBeNull();
    }
  });
});

describe("lineageOf", () => {
  const ports = (files: Record<string, string>) => {
    const warn = vi.fn();
    const paths: Record<string, string> = { [A]: "/a.jsonl", [B]: "/b.jsonl", [C]: "/c.jsonl" };
    return {
      warn,
      ports: {
        sessionStore: createSessionStore(fsStore(files)),
        find: async (id: string) => (paths[id] && paths[id] in files ? paths[id] : null),
        log: { warn, info: vi.fn(), error: vi.fn() },
      },
    };
  };

  it("lists a chain oldest first, each source cut where its child's base says", async () => {
    // C forked from B, which had forked from A.
    const files = {
      "/a.jsonl": meta(A),
      "/b.jsonl": meta(B, { thread_id: A, end_byte_offset: 10 }),
      "/c.jsonl": meta(C, { thread_id: B, end_byte_offset: 20 }),
    };
    const { ports: p } = ports(files);
    expect(await lineageOf(p, "/c.jsonl", { rolloutId: B, endByte: 20 })).toEqual([
      { path: "/a.jsonl", until: 10 },
      { path: "/b.jsonl", until: 20 },
      { path: "/c.jsonl" },
    ]);
  });

  it("reads from where it can when a source is gone, and says so", async () => {
    const { ports: p, warn } = ports({ "/c.jsonl": meta(C, { thread_id: B, end_byte_offset: 20 }) });
    expect(await lineageOf(p, "/c.jsonl", { rolloutId: B, endByte: 20 })).toEqual([{ path: "/c.jsonl" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not on disk"));
  });

  it("stops on a chain that comes back to itself", async () => {
    // A store edited into a loop must not read forever.
    const files = {
      "/a.jsonl": meta(A, { thread_id: B, end_byte_offset: 5 }),
      "/b.jsonl": meta(B, { thread_id: A, end_byte_offset: 5 }),
    };
    const { ports: p, warn } = ports(files);
    const parts = await lineageOf(p, "/c.jsonl", { rolloutId: B, endByte: 5 });
    expect(parts).toEqual([
      { path: "/a.jsonl", until: 5 },
      { path: "/b.jsonl", until: 5 },
      { path: "/c.jsonl" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("twice"));
  });
});
