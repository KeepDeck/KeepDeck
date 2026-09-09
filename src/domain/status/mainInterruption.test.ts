import { describe, expect, it } from "vitest";
import { reduceStatus, type PaneStatus } from "./activity";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";

const fold = (...events: AgentStatusEvent[]) => events.reduce<PaneStatus | null>(reduceStatus, null)!;
const running = () => fold(
  { kind: "turn-start", at: 100 }, { kind: "agent-turn-start", id: "bg", at: 110 },
  { kind: "interrupted", scope: "main", at: 120 },
);

describe("main-thread interruption with independent work", () => {
  it("holds the interruption until background work finishes, preserving its outcome", () => {
    const held = running();
    expect(held.activity).toEqual({ state: "working", since: 100 });
    expect(held.openAgentTurns).toEqual(new Set(["bg"]));
    expect(reduceStatus(held, { kind: "agent-turn-end", id: "other", at: 130 })).toBe(held);
    const ended = reduceStatus(held, { kind: "agent-turn-end", id: "bg", at: 150 })!;
    expect(ended.activity).toEqual({ state: "done", at: 150, interrupted: true });
    expect(ended.heldEnd).toBeNull();
  });

  it("a new main turn replaces the held interruption without losing the agent", () => {
    const next = reduceStatus(running(), { kind: "turn-observed", at: 130 })!;
    expect(next.heldEnd).toBeNull();
    const closed = reduceStatus(next, { kind: "agent-turn-end", id: "bg", at: 140 })!;
    expect(closed.activity.state).toBe("working");
    expect(reduceStatus(closed, { kind: "turn-end", at: 150 })!.activity).toMatchObject({
      state: "done", interrupted: false,
    });
  });

  it("stale observations cannot discard a held ending", () => {
    const held = running();
    expect(reduceStatus(held, { kind: "turn-observed", at: 100 })).toBe(held);
    expect(reduceStatus(held, { kind: "turn-observed", at: 110 })).toBe(held);
  });

  it("an authoritative empty agent list clears orphaned brackets", () => {
    const next = reduceStatus(running(), { kind: "turn-start", at: 200 })!;
    const ended = reduceStatus(next, { kind: "turn-end", at: 300, liveAgentIds: [] })!;
    expect(ended.openAgentTurns.size).toBe(0);
    expect(ended.activity).toEqual({ state: "done", at: 300, interrupted: false });
    expect(reduceStatus(next, { kind: "turn-end", at: 50, liveAgentIds: [] })).toBe(next);
  });
});
