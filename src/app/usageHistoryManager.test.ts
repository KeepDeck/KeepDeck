import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeUsageEvent,
  USAGE_HISTORY_RETENTION_MS,
  type UsageEventV2,
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

const event = (over: Record<string, unknown> = {}): UsageEventV2 =>
  ({
  schemaVersion: 2,
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
  }) as UsageEventV2;

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
      costSource: "provider",
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
          costSource: "provider",
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

  it("never invents a monetary cost when the CLI reports none", async () => {
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
    expect(written.costSource).toBe("unavailable");
    expect(written).not.toHaveProperty("costUsd");
    expect(written).not.toHaveProperty("pricingVersion");
  });

  it("records an explicit initial provider cost of zero", async () => {
    await initUsageHistory(NOW);
    await recordPaneUsage(
      {
        agent: "opencode",
        sessionId: "session-zero",
        costUsd: 0,
        reportedAt: NOW,
      },
      { ...context, sessionId: "session-zero" },
      NOW,
    );

    expect(JSON.parse(ipc.appendUsageHistory.mock.calls[0][0][0])).toMatchObject({
      costSource: "provider",
      costUsd: 0,
    });
  });

  it("merges independent cumulative token and provider-cost snapshots", async () => {
    await initUsageHistory(NOW);
    const claudeContext = { ...context, sessionId: "claude-session" };
    await recordPaneUsage(
      {
        agent: "claude",
        sessionId: "claude-session",
        costUsd: 1,
        reportedAt: NOW,
      },
      claudeContext,
      NOW,
    );
    await recordPaneUsage(
      {
        agent: "claude",
        sessionId: "claude-session",
        totalTokens: {
          input: 2,
          output: 3,
          cacheRead: 100,
          cacheWrite: 4,
        },
        costUsd: 1,
        reportedAt: NOW + 1,
      },
      claudeContext,
      NOW + 1,
    );

    expect(ipc.appendUsageHistory).toHaveBeenCalledTimes(2);
    const tokens = JSON.parse(ipc.appendUsageHistory.mock.calls[1][0][0]);
    expect(tokens).toMatchObject({
      tokens: { input: 2, output: 3, cacheRead: 100, cacheWrite: 4 },
      costSource: "unavailable",
      observation: {
        tokens: { input: 2, output: 3, cacheRead: 100, cacheWrite: 4 },
        costUsd: 1,
      },
    });
    expect(tokens).not.toHaveProperty("costUsd");
  });

  it("uses the first resumed cumulative report only as a baseline", async () => {
    await initUsageHistory(NOW);
    const claudeContext = {
      ...context,
      sessionId: "resumed-claude",
      baselineOnly: true,
    };
    const report = (costUsd: number, output: number, cacheRead: number) => ({
      agent: "claude",
      sessionId: "resumed-claude",
      totalTokens: { output, cacheRead },
      costUsd,
      reportedAt: NOW + output,
    });

    await recordPaneUsage(
      {
        agent: "claude",
        sessionId: "resumed-claude",
        costUsd: 140,
        reportedAt: NOW,
      },
      claudeContext,
      NOW,
    );
    await recordPaneUsage(
      {
        agent: "claude",
        sessionId: "resumed-claude",
        totalTokens: { output: 600, cacheRead: 900_000 },
        reportedAt: NOW + 1,
      },
      claudeContext,
      NOW + 1,
    );
    expect(ipc.appendUsageHistory).not.toHaveBeenCalled();

    await recordPaneUsage(report(141, 610, 1_800_000), claudeContext, NOW + 2);
    expect(ipc.appendUsageHistory).toHaveBeenCalledOnce();
    expect(
      JSON.parse(ipc.appendUsageHistory.mock.calls[0][0][0]),
    ).toMatchObject({
      tokens: { output: 10, cacheRead: 900_000 },
      costUsd: 1,
      costSource: "provider",
      observation: {
        tokens: { output: 610, cacheRead: 1_800_000 },
        costUsd: 141,
      },
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

  it("migrates v1 lines and compacts them as v2 instead of erasing history", async () => {
    ipc.loadUsageHistory.mockResolvedValue([
      JSON.stringify({
        ...event({ eventId: "legacy" }),
        schemaVersion: 1,
        costSource: "estimated",
        costUsd: 12,
        pricingVersion: "old-local-table",
      }),
    ]);

    await initUsageHistory(NOW);

    expect(getUsageHistorySnapshot().events).toHaveLength(1);
    expect(getUsageHistorySnapshot().events[0]).toMatchObject({
      schemaVersion: 2,
      eventId: "legacy",
      tokens: { input: 10 },
      costSource: "unavailable",
    });
    const compacted = JSON.parse(ipc.compactUsageHistory.mock.calls[0][0][0]);
    expect(compacted).not.toHaveProperty("costUsd");
    expect(compacted).not.toHaveProperty("pricingVersion");
  });
});
