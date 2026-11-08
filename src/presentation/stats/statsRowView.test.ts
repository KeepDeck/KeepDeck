import { describe, expect, it } from "vitest";
import type { UsageStatsRow } from "../../domain/usage/history/query";
import { shortSession, statsRowIdentity } from "./statsRowView";

const row = (over: Partial<UsageStatsRow> = {}): UsageStatsRow => ({
  key: "k",
  agent: "codex",
  tokens: {},
  totalTokens: 0,
  costUsd: 0,
  pricedEvents: 0,
  approximateEvents: 0,
  unpricedTokens: 0,
  lastOccurredAt: 0,
  ...over,
});

describe("shortSession", () => {
  it("keeps the first eight characters of a long id, and a short id whole", () => {
    expect(shortSession("session-123456789")).toBe("session-…");
    expect(shortSession("123456789012")).toBe("123456789012");
    expect(shortSession("1234567890123")).toBe("12345678…");
  });

  it("says when there is no session to name", () => {
    expect(shortSession(undefined)).toBe("Unknown session");
    expect(shortSession("")).toBe("Unknown session");
  });
});

describe("statsRowIdentity", () => {
  it("names a model row by the catalogue, else its key, and says which agent ran it", () => {
    expect(
      statsRowIdentity(row({ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" }), "model"),
    ).toEqual({ name: "GPT-6.1 Sol", detail: "codex" });
    expect(statsRowIdentity(row({ model: "kimi/k3" }), "model").name).toBe("kimi/k3");
    expect(statsRowIdentity(row(), "model").name).toBe("Unknown model");
  });

  it("names a session row by its pane, else its session, and says where and by whom", () => {
    const session = row({ paneName: "auth-refactor", workspaceName: "KeepDeck", sessionId: "session-123456789" });
    expect(statsRowIdentity(session, "session")).toEqual({
      name: "auth-refactor",
      detail: "KeepDeck · codex · session-…",
    });
    expect(statsRowIdentity({ ...session, paneName: undefined }, "session").name).toBe("session-…");
  });

  it("leaves out of the detail what it does not know", () => {
    expect(statsRowIdentity(row({ sessionId: "s1" }), "session").detail).toBe("codex · s1");
  });
});
