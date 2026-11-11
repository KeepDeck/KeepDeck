import type { CostBasis, UsageRow } from "./event";

/**
 * The shared UsageRow builder for tests — replaces eight hand-copied
 * builders whose defaults had silently drifted. Files with a real
 * personality wrap this with their own defaults spelled out, instead of
 * re-copying the whole shape.
 *
 * A row is unpriced unless the test gives it a cost; a cost without a basis
 * is an estimate.
 */

export const TEST_NOW = Date.parse("2026-07-22T12:00:00.000Z");

/** What a test may set on a row: any field, and its money and basis apart
 * — a saving rides only on a priced row, as the core serves it. */
export type UsageRowOverrides = Partial<Omit<UsageRow, "costBasis" | "costUsd" | "savedUsd">> & {
  costBasis?: CostBasis;
  costUsd?: number;
  savedUsd?: number;
};

let seq = 0;

export function usageEvent(over: UsageRowOverrides = {}): UsageRow {
  seq += 1;
  const { costBasis, costUsd, savedUsd, ...fields } = over;
  const row = {
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
    // One booked event, one call — a bucket says otherwise explicitly.
    count: 1,
    calls: 1,
    ...fields,
  };
  return costUsd === undefined || costBasis === "unpriced"
    ? { ...row, costBasis: "unpriced" }
    : { ...row, costBasis: costBasis ?? "estimated", costUsd, ...(savedUsd === undefined ? {} : { savedUsd }) };
}
