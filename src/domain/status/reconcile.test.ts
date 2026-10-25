import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import { reconcileVerdict, reduceStatus, type PaneStatus } from "./activity";

const fold = (...edges: AgentStatusEvent[]) => edges.reduce<PaneStatus | null>(reduceStatus, null);
const working = fold({ kind: "turn-start", at: 100 });

describe("reconcileVerdict — a replay may only end the turn shown running", () => {
  it("ends a running turn with the store's last ending", () => {
    expect(reconcileVerdict(working, [{ kind: "turn-observed", at: 101 }, { kind: "turn-end", at: 200 }]))
      .toEqual({ kind: "end", edge: { kind: "turn-end", at: 200 } });
    const waiting = reduceStatus(working, { kind: "waiting", at: 150, reason: "permission" });
    expect(reconcileVerdict(waiting, [{ kind: "interrupted", at: 200 }])).toEqual({ kind: "end", edge: { kind: "interrupted", at: 200 } });
  });

  it("ends nothing when something started after the last ending", () => {
    for (const start of [
      { kind: "turn-observed", at: 300 },
      { kind: "turn-start", at: 300 },
      { kind: "agent-turn-start", at: 300, id: "a1" },
    ] satisfies AgentStatusEvent[]) {
      expect(reconcileVerdict(working, [{ kind: "turn-end", at: 200 }, start])).toEqual({ kind: "skip", reason: "started-after" });
    }
  });

  it("leaves a finished or silent pane alone", () => {
    const done = reduceStatus(working, { kind: "turn-end", at: 150 });
    expect(reconcileVerdict(done, [{ kind: "turn-end", at: 200 }])).toEqual({ kind: "skip", reason: "pane-not-running" });
    expect(reconcileVerdict(null, [{ kind: "interrupted", at: 200 }])).toEqual({ kind: "skip", reason: "pane-not-running" });
  });

  it("has nothing to say of a replay with no ending — and never starts a turn", () => {
    expect(reconcileVerdict(null, [{ kind: "turn-observed", at: 300 }])).toBeNull();
    expect(reconcileVerdict(working, [])).toBeNull();
  });
});
