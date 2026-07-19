import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { opencodeHistory, partText } from "./history";

function ctx(results: ((string | null)[][] | Error)[]) {
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

describe("opencode history", () => {
  it("lists unarchived sessions with time_updated as the fingerprint", async () => {
    const { ctx: c, query } = ctx([[["ses_1", "1769121238325"]]]);
    const history = opencodeHistory(c);
    expect(await history.list()).toEqual([
      { sessionId: "ses_1", ref: "ses_1", mtime: 1769121238325, size: 0 },
    ]);
    expect(query.mock.calls[0][1]).toContain("time_archived IS NULL");
  });

  it("a missing store lists empty instead of failing the scan", async () => {
    const { ctx: c } = ctx([new Error("no such db")]);
    expect(await opencodeHistory(c).list()).toEqual([]);
  });

  it("content keeps only text parts; transcript groups parts per message", async () => {
    const text = (t: string) => JSON.stringify({ type: "text", text: t });
    const tool = JSON.stringify({ type: "tool", tool: "bash" });
    const { ctx: c } = ctx([
      [[text("hello")], [tool], [text("world")]],
      [
        ["m1", JSON.stringify({ role: "user" })],
        ["m2", JSON.stringify({ role: "assistant" })],
      ],
      [
        ["m1", text("hello")],
        ["m2", tool],
        ["m2", text("world")],
      ],
    ]);
    const history = opencodeHistory(c);
    expect(await history.content("ses_1")).toBe("hello\nworld");
    expect(await history.transcript("ses_1", { offset: 0, limit: 10 })).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
  });

  it("partText rejects non-text and torn rows", () => {
    expect(partText('{"type":"tool","x":1}')).toBeNull();
    expect(partText("{torn")).toBeNull();
  });
});
