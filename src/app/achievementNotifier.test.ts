import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../domain/usage/history";

const ipc = vi.hoisted(() => ({
  loadNotifiedAchievements: vi.fn<() => Promise<string | null>>(),
  saveNotifiedAchievements: vi.fn<(json: string) => Promise<void>>(),
}));
vi.mock("../ipc/achievements", () => ipc);

const center = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("./notificationCenter", () => center);

const history = vi.hoisted(() => ({
  snapshot: {
    ready: false,
    events: [] as UsageEventV2[],
    error: null as string | null,
  },
  listeners: new Set<() => void>(),
}));
vi.mock("./usageHistoryManager", () => ({
  getUsageHistorySnapshot: () => history.snapshot,
  subscribeUsageHistory: (listener: () => void) => {
    history.listeners.add(listener);
    return () => history.listeners.delete(listener);
  },
}));

import {
  initAchievementNotifier,
  resetAchievementNotifier,
} from "./achievementNotifier";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
let seq = 0;
const event = (over: Record<string, unknown> = {}): UsageEventV2 =>
  ({
    schemaVersion: 2,
    eventId: `event-${(seq += 1)}`,
    occurredAt: NOW - 1_000,
    capturedAt: NOW - 1_000,
    agent: "codex",
    model: "gpt-5.6-terra",
    workspaceId: "ws-1",
    workspaceName: "KeepDeck",
    workspaceCwd: "/repo",
    paneId: "pane-1",
    paneName: "Agent 1",
    sessionId: "s1",
    rootSessionId: "s1",
    tokens: { input: 100 },
    costSource: "unavailable",
    observation: { tokens: { input: 100 } },
    ...over,
  }) as UsageEventV2;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// 2M tokens + provider cost earns: First Million, Warm Afternoon,
// Hello Agent, First Dollar — four fresh awards.
const richEvents = () => [
  event({ tokens: { input: 2_000_000 }, costSource: "provider", costUsd: 1.5 }),
];

describe("achievementNotifier", () => {
  beforeEach(() => {
    resetAchievementNotifier();
    history.snapshot = { ready: true, events: [], error: null };
    history.listeners.clear();
    ipc.loadNotifiedAchievements.mockReset().mockResolvedValue(null);
    ipc.saveNotifiedAchievements.mockReset().mockResolvedValue(undefined);
    center.notify.mockReset();
  });

  afterEach(() => resetAchievementNotifier());

  it("congratulates retroactively on first run, one notification per award", async () => {
    history.snapshot = { ready: true, events: richEvents(), error: null };
    initAchievementNotifier();
    await settle();

    // No summary batching (user decision): four awards, four notifications.
    expect(center.notify).toHaveBeenCalledTimes(4);
    const titles = center.notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    expect(titles).toContain("Achievement unlocked: First Million");
    expect(titles).toContain("Achievement unlocked: First Dollar");
    expect(center.notify.mock.calls[0][0]).toMatchObject({
      source: { type: "stats", tab: "achievements" },
    });
    const saved = JSON.parse(ipc.saveNotifiedAchievements.mock.calls[0][0]);
    expect(saved.notified).toContain("tokens-1000000");
    expect(saved.notified).toContain("spendUsd-1");
  });

  it("announces few fresh awards individually, skipping the congratulated set", async () => {
    ipc.loadNotifiedAchievements.mockResolvedValue(
      JSON.stringify({
        version: 1,
        notified: ["tokens-1000000", "dayTokens-1000000", "sessions-1"],
      }),
    );
    history.snapshot = { ready: true, events: richEvents(), error: null };
    initAchievementNotifier();
    await settle();

    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify.mock.calls[0][0]).toMatchObject({
      title: "Achievement unlocked: First Dollar",
      body: "$1 provider-reported spend",
      tag: "achievement:spendUsd-1",
    });
  });

  it("stays silent when nothing new is earned", async () => {
    ipc.loadNotifiedAchievements.mockResolvedValue(
      JSON.stringify({
        version: 1,
        notified: [
          "tokens-1000000",
          "dayTokens-1000000",
          "sessions-1",
          "spendUsd-1",
        ],
      }),
    );
    history.snapshot = { ready: true, events: richEvents(), error: null };
    initAchievementNotifier();
    await settle();

    expect(center.notify).not.toHaveBeenCalled();
    expect(ipc.saveNotifiedAchievements).not.toHaveBeenCalled();
  });

  it("waits for history readiness, then reacts to appends", async () => {
    history.snapshot = { ready: false, events: [], error: null };
    initAchievementNotifier();
    await settle();
    expect(center.notify).not.toHaveBeenCalled();

    history.snapshot = { ready: true, events: [event()], error: null };
    for (const listener of history.listeners) listener();
    await settle();
    // A lone session earns exactly "Hello, Agent".
    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify.mock.calls[0][0]).toMatchObject({
      title: "Achievement unlocked: Hello, Agent",
    });
  });

  it("treats an unreadable baseline as empty instead of staying silent", async () => {
    ipc.loadNotifiedAchievements.mockResolvedValue("torn{");
    history.snapshot = { ready: true, events: [event()], error: null };
    initAchievementNotifier();
    await settle();
    expect(center.notify).toHaveBeenCalledTimes(1);
  });
});
