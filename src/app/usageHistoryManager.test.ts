import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeUsageEvent,
  USAGE_HISTORY_RETENTION_MS,
  type UsageEventV1,
} from "../domain/usage/history";

const ipc = vi.hoisted(() => ({
  loadUsageHistory: vi.fn<() => Promise<string[]>>(),
  appendUsageHistory: vi.fn<(lines: string[]) => Promise<void>>(),
  compactUsageHistory: vi.fn<(lines: string[]) => Promise<void>>(),
}));
vi.mock("../ipc/usageHistory", () => ipc);

import {
  getUsageHistorySnapshot,
  initUsageHistory,
  recordPaneUsage,
  resetUsageHistoryManager,
} from "./usageHistoryManager";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const context = {
  workspaceId: "ws-1",
  workspaceName: "KeepDeck",
  workspaceCwd: "/repo",
  paneId: "pane-1",
  paneName: "Agent 1",
  sessionId: "session-1",
};

const event = (over: Partial<UsageEventV1> = {}): UsageEventV1 => ({
  schemaVersion: 1,
  eventId: "event-1",
  occurredAt: NOW - 1_000,
  capturedAt: NOW - 900,
  agent: "opencode",
  workspaceId: "ws-1",
  workspaceName: "KeepDeck",
  workspaceCwd: "/repo",
  paneId: "pane-1",
  paneName: "Agent 1",
  sessionId: "session-1",
  rootSessionId: "session-1",
  tokens: { input: 10 },
  costSource: "unavailable",
  observation: { tokens: { input: 10 } },
  ...over,
});

describe("usageHistoryManager", () => {
  beforeEach(() => {
    resetUsageHistoryManager();
    ipc.loadUsageHistory.mockReset().mockResolvedValue([]);
    ipc.appendUsageHistory.mockReset().mockResolvedValue(undefined);
    ipc.compactUsageHistory.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => resetUsageHistoryManager());

  it("records only positive deltas from cumulative pane snapshots", async () => {
    await initUsageHistory(NOW);
    await recordPaneUsage(
      {
        agent: "opencode",
        sessionId: "session-1",
        totalTokens: { input: 100, output: 10 },
        costUsd: 1,
        reportedAt: NOW,
      },
      context,
      NOW,
    );
    await recordPaneUsage(
      {
        agent: "opencode",
        sessionId: "session-1",
        totalTokens: { input: 130, output: 15 },
        costUsd: 1.4,
        reportedAt: NOW + 1,
      },
      context,
      NOW + 1,
    );

    expect(ipc.appendUsageHistory).toHaveBeenCalledTimes(2);
    const second = JSON.parse(ipc.appendUsageHistory.mock.calls[1][0][0]);
    expect(second).toMatchObject({
      tokens: { input: 30, output: 5 },
      costUsd: 0.4,
      costSource: "reported",
      observation: { tokens: { input: 130, output: 15 }, costUsd: 1.4 },
    });
    expect(getUsageHistorySnapshot().events).toHaveLength(2);
  });

  it("does not recount a replayed cumulative snapshot after reload", async () => {
    ipc.loadUsageHistory.mockResolvedValue([
      encodeUsageEvent(
        event({
          observation: { tokens: { input: 100 }, costUsd: 1 },
          costUsd: 1,
          costSource: "reported",
        }),
      ),
    ]);
    await initUsageHistory(NOW);

    await recordPaneUsage(
      {
        agent: "opencode",
        totalTokens: { input: 100 },
        costUsd: 1,
        reportedAt: NOW,
      },
      context,
      NOW,
    );

    expect(ipc.appendUsageHistory).not.toHaveBeenCalled();
  });

  it("estimates exact Codex models and preserves the pricing version", async () => {
    await initUsageHistory(NOW);
    await recordPaneUsage(
      {
        agent: "codex",
        model: "gpt-5.6-terra high",
        totalTokens: { input: 1_000_000, cacheRead: 800_000, output: 100_000 },
        reportedAt: NOW,
      },
      { ...context, sessionId: "codex-session" },
      NOW,
    );

    const written = JSON.parse(ipc.appendUsageHistory.mock.calls[0][0][0]);
    expect(written).toMatchObject({
      costSource: "estimated",
      costUsd: 2.2,
      pricingVersion: "openai-standard-2026-07-22",
    });
  });

  it("deduplicates damage and retains one expired baseline checkpoint", async () => {
    const expired = event({
      eventId: "old-latest",
      occurredAt: NOW - USAGE_HISTORY_RETENTION_MS - 1,
      capturedAt: NOW - 10,
      observation: { tokens: { input: 50 } },
    });
    const older = event({
      eventId: "old-older",
      occurredAt: NOW - USAGE_HISTORY_RETENTION_MS - 2,
      capturedAt: NOW - 20,
    });
    const current = event({ eventId: "current", sessionId: "session-2", rootSessionId: "session-2" });
    ipc.loadUsageHistory.mockResolvedValue([
      encodeUsageEvent(older),
      "torn{",
      encodeUsageEvent(expired),
      encodeUsageEvent(current),
      encodeUsageEvent(current),
    ]);

    await initUsageHistory(NOW);

    expect(getUsageHistorySnapshot().events.map((item) => item.eventId)).toEqual([
      "current",
    ]);
    const compacted = ipc.compactUsageHistory.mock.calls[0][0].map((line) =>
      JSON.parse(line),
    );
    expect(compacted.map((item) => item.eventId)).toEqual([
      "old-latest",
      "current",
    ]);
  });
});
