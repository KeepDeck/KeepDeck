import { describe, expect, it } from "vitest";
import { forkTranscriptOf } from "./doors";

/** The index as the plugins declared it: agent and session to file. */
function index(known: Record<string, string>) {
  const asked: string[] = [];
  const locate = (agent: string, sessionId: string) => {
    asked.push(`${agent}:${sessionId}`);
    return Promise.resolve(known[`${agent}:${sessionId}`] ?? null);
  };
  return { asked, locate };
}

describe("the file a fork copies", () => {
  it("is the one the binding reported; the index is not asked", async () => {
    const { asked, locate } = index({ "claude:s-1": "/index/s-1.jsonl" });
    expect(await forkTranscriptOf({ agent: "claude", sessionId: "s-1", transcriptPath: "/t/s-1.jsonl" }, locate)).toBe("/t/s-1.jsonl");
    expect(asked).toEqual([]);
  });

  it("is the one the index knows, for a record the binding gave none", async () => {
    const { asked, locate } = index({ "claude:s-1": "/index/s-1.jsonl" });
    expect(await forkTranscriptOf({ agent: "claude", sessionId: "s-1" }, locate)).toBe("/index/s-1.jsonl");
    expect(asked).toEqual(["claude:s-1"]);
  });

  it("is left out when nobody knows it — the plugin decides whether it needs one", async () => {
    const { locate } = index({});
    expect(await forkTranscriptOf({ agent: "claude", sessionId: "s-1" }, locate)).toBeUndefined();
  });
});
