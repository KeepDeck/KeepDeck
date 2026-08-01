import type { UsageEventV2 } from "./history";

/**
 * The shared UsageEventV2 builder for tests — replaces eight hand-copied
 * builders whose defaults had silently drifted (one file defaulted
 * costSource to "provider" while its siblings said "unavailable", so an
 * identically-written assertion passed in one and failed in another).
 * Files with a real personality wrap this with their own defaults spelled
 * out, instead of re-copying the whole shape.
 */

export const TEST_NOW = Date.parse("2026-07-22T12:00:00.000Z");

let seq = 0;

export function usageEvent(over: Record<string, unknown> = {}): UsageEventV2 {
  seq += 1;
  return {
    schemaVersion: 2,
    eventId: `event-${seq}`,
    occurredAt: TEST_NOW - 1_000,
    capturedAt: TEST_NOW - 1_000,
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
  } as UsageEventV2;
}
