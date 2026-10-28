import { describe, expect, it } from "vitest";
import { isV1CostSource, salvageV1Event, type V1Line } from "./migrateV1";

const common: V1Line["common"] = {
  eventId: "e-1",
  occurredAt: 1,
  capturedAt: 2,
  agent: "codex",
  workspaceId: "ws-1",
  workspaceName: "deck",
  workspaceCwd: "/repo",
  paneId: "pane-1",
  paneName: "lead",
  sessionId: "s-1",
  rootSessionId: "s-1",
};
const line = (over: Partial<V1Line> = {}): V1Line => ({
  common,
  tokens: { input: 10, output: 5 },
  observedTokens: { input: 100, output: 50 },
  observationCost: 0.5,
  costSource: "reported",
  costUsd: 0.25,
  ...over,
});

describe("salvageV1Event", () => {
  it("keeps a trustworthy agent's tokens and its provider-reported cost", () => {
    expect(salvageV1Event(line(), 2)).toEqual({
      ...common,
      schemaVersion: 2,
      tokens: { input: 10, output: 5 },
      costSource: "provider",
      costUsd: 0.25,
      observation: { tokens: { input: 100, output: 50 }, costUsd: 0.5 },
    });
  });

  it("discards a locally estimated cost, keeping the tokens", () => {
    const event = salvageV1Event(line({ costSource: "estimated" }), 2);
    expect(event).toMatchObject({ costSource: "unavailable", tokens: { input: 10, output: 5 } });
    expect(event).not.toHaveProperty("costUsd");
  });

  it("drops claude's v1 counters, keeping only a positive reported cost", () => {
    const claude = { ...common, agent: "claude" };
    expect(salvageV1Event(line({ common: claude }), 2)).toMatchObject({
      tokens: {},
      costSource: "provider",
      costUsd: 0.25,
      observation: { tokens: {}, costUsd: 0.5 },
    });
    expect(salvageV1Event(line({ common: claude, costUsd: 0 }), 2)).toBeNull();
    expect(salvageV1Event(line({ common: claude, costSource: "estimated" }), 2)).toBeNull();
  });
});

describe("isV1CostSource", () => {
  it("admits the three sources v1 wrote, and nothing else", () => {
    for (const source of ["reported", "estimated", "unavailable"]) expect(isV1CostSource(source)).toBe(true);
    for (const source of ["provider", "", undefined, 1]) expect(isV1CostSource(source)).toBe(false);
  });
});
