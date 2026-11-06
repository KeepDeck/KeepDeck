import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import {
  acrossSessionChange,
  isCalm,
  processStarted,
  reduceStatus,
  survivesSessionChange,
  type PaneActivity,
  type PaneStatus,
} from "./activity";

/**
 * The two states with no turn behind them (task-570): `started` — the host
 * saw the agent's process come up — and `ready` — the agent said it is at
 * its prompt. Every rule about them is here; the fold's turn rules have
 * their own files.
 */
const pane = (activity: PaneActivity, open: readonly string[] = []): PaneStatus => ({
  activity,
  openAgentTurns: new Set(open),
  heldEnd: null,
});

const started = (since: number) => pane({ state: "started", since });
const ready = (since: number) => pane({ state: "ready", since });

describe("a ready edge", () => {
  it("over silence: the agent is at its prompt", () => {
    expect(reduceStatus(null, { kind: "ready", at: 100 })?.activity).toEqual({
      state: "ready",
      since: 100,
    });
  });

  it("never moves a running turn — the turn's own ending says when it is over", () => {
    // opencode's plugin can finish loading after a prompt given at spawn has
    // started a turn; the late word that it is idle must not end that turn.
    const working = pane({ state: "working", since: 100 }, ["agent-1"]);
    const heldOver: PaneStatus = {
      ...working,
      heldEnd: { kind: "turn-end", at: 150 },
    };
    const waiting = pane({ state: "waiting", since: 100, reason: "permission" });
    for (const current of [working, heldOver, waiting]) {
      expect(reduceStatus(current, { kind: "ready", at: 200 })).toBe(current);
    }
  });

  it("after a finished turn is the next conversation's — `/clear` once the turn is done", () => {
    const done = pane({ state: "done", at: 100, interrupted: false });
    const failed = pane({ state: "failed", at: 100, error: "rate_limit" });
    for (const current of [done, failed]) {
      expect(reduceStatus(current, { kind: "ready", at: 100 })?.activity).toEqual({
        state: "ready",
        since: 100,
      });
    }
  });

  it("stamped before the turn it would follow ended belongs to before it", () => {
    const done = pane({ state: "done", at: 100, interrupted: false });
    expect(reduceStatus(done, { kind: "ready", at: 99 })).toBe(done);
  });

  it("said again is the same prompt: the phase keeps its start and its identity", () => {
    // opencode loads its plugin twice, and both loads say so.
    const current = ready(100);
    expect(reduceStatus(current, { kind: "ready", at: 200 })).toBe(current);
  });

  it("outranks the host's sighting whenever it was stamped", () => {
    // A ready held across a change of conversation lands on the `started`
    // the change left, stamped before it — and is still true.
    expect(reduceStatus(started(500), { kind: "ready", at: 100 })?.activity).toEqual({
      state: "ready",
      since: 100,
    });
  });
});

describe("an edge over a calm pane", () => {
  /** Edges a calm state cannot contradict, each newer than the calm phase. */
  const edges: readonly AgentStatusEvent[] = [
    { kind: "turn-start", at: 300 },
    { kind: "turn-observed", at: 300 },
    { kind: "waiting", at: 300, reason: "permission" },
    { kind: "resumed", at: 300 },
    { kind: "parked", at: 300 },
    { kind: "agent-turn-start", at: 300, id: "agent-1" },
    { kind: "turn-end", at: 300 },
    { kind: "interrupted", at: 300 },
    { kind: "turn-failed", at: 300, error: "rate_limit" },
  ];

  it("folds as over silence — a turn the pane missed the start of is still that turn", () => {
    for (const calm of [started(200), ready(200)]) {
      for (const edge of edges) {
        expect(reduceStatus(calm, edge), `${calm.activity.state} + ${edge.kind}`).toEqual(
          reduceStatus(null, edge),
        );
      }
    }
  });

  it("stands where silence would settle nothing", () => {
    const settlesNothing: readonly AgentStatusEvent[] = [
      { kind: "agent-turn-end", at: 300, id: "agent-1" },
      { kind: "agent-turns-cleared", at: 300 },
      { kind: "context-compacted", at: 300 },
      { kind: "permission-mode", at: 300, mode: "yolo" },
    ];
    for (const calm of [started(200), ready(200)]) {
      for (const edge of settlesNothing) {
        expect(reduceStatus(calm, edge), `${calm.activity.state} + ${edge.kind}`).toBe(calm);
      }
    }
  });

  it("older than the agent's own ready belongs to before it — only a fresh turn-start wins", () => {
    // A store's late marker of the conversation the agent left.
    const current = ready(200);
    for (const edge of edges.filter((edge) => edge.kind !== "turn-start")) {
      expect(reduceStatus(current, { ...edge, at: 100 }), edge.kind).toBe(current);
    }
    expect(reduceStatus(current, { kind: "turn-start", at: 100 })?.activity).toEqual({
      state: "working",
      since: 100,
    });
  });

  it("older than the host's sighting still lands — `started` is no phase the agent stated", () => {
    // A prompt given at spawn is reported while the process is starting and
    // settled after it is up — the tracker re-labels that held start an
    // observation, which must not be refused as the turn before.
    expect(reduceStatus(started(200), { kind: "turn-observed", at: 100 })?.activity).toEqual({
      state: "working",
      since: 100,
    });
  });
});

describe("processStarted", () => {
  it("a pane nothing was said for reads started from when the host saw it", () => {
    expect(processStarted(null, 100)).toEqual(started(100));
  });

  it("the agent's own word outranks the host's sighting — a hook can beat the spawn", () => {
    for (const current of [ready(50), pane({ state: "working", since: 50 }), started(50)]) {
      expect(processStarted(current, 100)).toBe(current);
    }
  });
});

describe("acrossSessionChange", () => {
  it("keeps ready, and nothing that came with it — the change happens at the prompt", () => {
    const current: PaneStatus = {
      activity: { state: "ready", since: 100 },
      openAgentTurns: new Set(["agent-1"]),
      heldEnd: null,
    };
    const next = acrossSessionChange(current, 300);
    expect(next?.activity).toBe(current.activity);
    expect(next?.openAgentTurns.size).toBe(0);
  });

  it("leaves the old conversation's turn, ending and failure behind: the pane reads started", () => {
    for (const current of [
      pane({ state: "working", since: 100 }, ["agent-1"]),
      pane({ state: "waiting", since: 100, reason: "permission" }),
      pane({ state: "done", at: 100, interrupted: false }),
      pane({ state: "failed", at: 100, error: "rate_limit" }),
      started(100),
    ]) {
      expect(acrossSessionChange(current, 300), current.activity.state).toEqual(started(300));
    }
  });

  it("claims nothing for a pane nothing was known about", () => {
    expect(acrossSessionChange(null, 300)).toBeNull();
  });

  it("lets through a held report only what it leaves true", () => {
    expect(survivesSessionChange({ kind: "ready", at: 1 })).toBe(true);
    for (const edge of [
      { kind: "turn-start", at: 1 },
      { kind: "turn-end", at: 1 },
      { kind: "waiting", at: 1, reason: "permission" },
      { kind: "permission-mode", at: 1, mode: "ask" },
    ] as const) {
      expect(survivesSessionChange(edge), edge.kind).toBe(false);
    }
  });
});

describe("isCalm", () => {
  it("names the two states with no turn behind them", () => {
    const all: readonly PaneActivity[] = [
      { state: "started", since: 1 },
      { state: "ready", since: 1 },
      { state: "working", since: 1 },
      { state: "waiting", since: 1, reason: "question" },
      { state: "done", at: 1, interrupted: true },
      { state: "failed", at: 1, error: "unknown" },
    ];
    expect(all.filter(isCalm).map((activity) => activity.state)).toEqual(["started", "ready"]);
  });
});
