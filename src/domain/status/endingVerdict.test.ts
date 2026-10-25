import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import { activityWord, endingVerdict, reduceStatus, type PaneStatus } from "./activity";

/** Fold edges from nothing, the way the tracker does. */
const fold = (...edges: AgentStatusEvent[]) => edges.reduce<PaneStatus | null>(reduceStatus, null);

const verdictOf = (before: PaneStatus | null, edge: AgentStatusEvent) =>
  endingVerdict(before, edge, reduceStatus(before, edge));

describe("endingVerdict", () => {
  it("says nothing of an edge that does not end a turn", () => {
    expect(verdictOf(null, { kind: "turn-start", at: 1 })).toBeNull();
  });

  it("names an ending that ended the turn", () => {
    expect(verdictOf(fold({ kind: "turn-start", at: 100 }), { kind: "turn-end", at: 200 })).toEqual({ kind: "ended" });
  });

  it("names why an ending changed nothing", () => {
    const working = fold({ kind: "turn-start", at: 100 });
    expect(verdictOf(working, { kind: "turn-end", at: 50 })).toEqual({ kind: "refused", reason: "older-than-phase" });
    const done = fold({ kind: "turn-start", at: 100 }, { kind: "turn-end", at: 200 });
    expect(verdictOf(done, { kind: "turn-end", at: 300 })).toEqual({ kind: "refused", reason: "already-ended" });
  });

  it("names an ending held behind an open agent turn, and one older than it", () => {
    const busy = fold({ kind: "turn-start", at: 100 }, { kind: "agent-turn-start", at: 150, id: "a1" });
    expect(verdictOf(busy, { kind: "turn-end", at: 200 })).toEqual({ kind: "held", open: 1 });
    const held = reduceStatus(busy, { kind: "turn-end", at: 200 });
    expect(verdictOf(held, { kind: "turn-end", at: 180 })).toEqual({ kind: "refused", reason: "older-than-held-end" });
  });
});

describe("activityWord", () => {
  it("names each state, and an interrupted ending apart", () => {
    expect(activityWord(undefined)).toBe("none");
    expect(activityWord({ state: "working", since: 1 })).toBe("working");
    expect(activityWord({ state: "done", at: 1, interrupted: true })).toBe("done (interrupted)");
    expect(activityWord({ state: "done", at: 1, interrupted: false })).toBe("done");
  });
});
