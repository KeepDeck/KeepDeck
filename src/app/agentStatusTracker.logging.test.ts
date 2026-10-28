import { beforeEach, describe, expect, it, vi } from "vitest";
import { isJsonRecord, type AgentStatusEvent, type StatusNormalizer } from "@keepdeck/plugin-api";

const lines = vi.hoisted((): string[] => []);
vi.mock("../ipc/log", () => ({
  log: {
    info: (_target: string, message: string) => lines.push(message),
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { createAgentStatusTracker } from "./agentStatusTracker";

/** A normalizer that hands back the edge its envelope names — the logging is
 * the tracker's, whatever agent's normalizer minted the edge. */
const edgeOf: StatusNormalizer = (payload) => {
  if (!isJsonRecord(payload) || !isJsonRecord(payload.edge)) return null;
  const { kind, at, id } = payload.edge;
  if (typeof kind !== "string" || typeof at !== "number") return null;
  if (kind === "agent-turn-start" && typeof id === "string") return { kind, at, id };
  if (kind === "turn-start" || kind === "turn-end") return { kind, at };
  return null;
};

const hook = (name: string, edge: AgentStatusEvent) => ({ agent: "x", event: { hook_event_name: name }, edge });

/** The fake agent's own reading of a hook's name, as its plugin's
 * `attribute` would give it. */
const eventOf = (payload: unknown) =>
  isJsonRecord(payload) && isJsonRecord(payload.event) && typeof payload.event.hook_event_name === "string"
    ? payload.event.hook_event_name
    : null;
const record = (edge: AgentStatusEvent, body: string) => ({ agent: "x", kind: "store.record", record: { body }, edge });

describe("the tracker's account of a pane's status", () => {
  beforeEach(() => {
    lines.length = 0;
  });

  it("logs each transition with its edge, source time and cause — a few lines per turn, no record body", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", edgeOf, eventOf);
    const start = new Date(2026, 9, 25, 18, 57, 13, 426).getTime();
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: start }));
    tracker.report("pane-1", record({ kind: "turn-end", at: start + 407_890 }, "the private words of a reply"));
    expect(lines).toEqual([
      "pane-1: none → working by turn-start@18:57:13.426 (UserPromptSubmit)",
      "pane-1: working → done by turn-end@19:04:01.316 (store.record)",
    ]);
    expect(lines.join("\n")).not.toContain("private");
  });

  it("logs an ending it refused, and one it held, with the reason", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", edgeOf);
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: 1_000 }));
    lines.length = 0;
    tracker.report("pane-1", record({ kind: "turn-end", at: 500 }, "old"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pane-1: turn-end@\S+ \(store\.record\) refused — older than the running phase, since \S+$/);

    lines.length = 0;
    tracker.report("pane-1", record({ kind: "agent-turn-start", at: 1_100, id: "a1" }, "x"));
    tracker.report("pane-1", record({ kind: "turn-end", at: 1_200 }, "x"));
    expect(lines).toEqual([expect.stringMatching(/^pane-1: turn-end@\S+ \(store\.record\) held — 1 agent turn\(s\) still open$/)]);
  });

  it("says nothing of an edge that moves nothing", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", edgeOf);
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: 1_000 }));
    lines.length = 0;
    tracker.report("pane-1", { agent: "x", event: { hook_event_name: "PostToolUse" } });
    expect(lines).toEqual([]);
  });
});

describe("a reconcile — the tail's replay of a store's latest turn boundaries", () => {
  beforeEach(() => {
    lines.length = 0;
  });

  const batch = (...edges: AgentStatusEvent[]) => ({
    agent: "x", kind: "store.batch", reconcile: true, records: edges.map((edge) => ({ edge })),
  });
  /** The batch's records reach the normalizer one by one, as carried records. */
  const fromRecords: StatusNormalizer = (payload, at, context) =>
    isJsonRecord(payload) && !isJsonRecord(payload.edge) && isJsonRecord(payload.record)
      ? edgeOf(payload.record, at, context)
      : edgeOf(payload, at, context);
  const lastLine = () => lines[lines.length - 1];

  it("ends the turn a hook started, when the store already recorded its end", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", fromRecords);
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: 1_000 }));
    tracker.report("pane-1", batch({ kind: "turn-start", at: 1_001 }, { kind: "turn-end", at: 1_500 }));
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({ state: "done", at: 1_500, interrupted: false });
    expect(lastLine()).toMatch(/working → done by turn-end@\S+ \(store\.batch\(2, reconcile\)\)$/);
  });

  it("never ends the turn running now with an older one's end", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", fromRecords);
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: 2_000 }));
    tracker.report("pane-1", batch({ kind: "turn-end", at: 1_500 }));
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({ state: "working", since: 2_000 });
    expect(lastLine()).toMatch(/refused — older than the running phase/);
  });

  it("never starts a turn, and leaves a finished pane alone", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", fromRecords);
    tracker.report("pane-1", batch({ kind: "turn-start", at: 3_000 }));
    expect(tracker.getSnapshot().panes.get("pane-1")).toBeUndefined();
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: 1_000 }));
    tracker.report("pane-1", record({ kind: "turn-end", at: 1_200 }, "x"));
    tracker.report("pane-1", batch({ kind: "turn-end", at: 1_300 }));
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({ state: "done", at: 1_200, interrupted: false });
    expect(lastLine()).toMatch(/store\.batch\(1, reconcile\) ends nothing — the pane shows no running turn$/);
  });

  it("ends nothing when the store records a turn started after its last ending", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", fromRecords);
    tracker.report("pane-1", hook("UserPromptSubmit", { kind: "turn-start", at: 1_000 }));
    tracker.report("pane-1", batch({ kind: "turn-end", at: 900 }, { kind: "turn-start", at: 1_001 }));
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({ state: "working", since: 1_000 });
    expect(lastLine()).toMatch(/ends nothing — a turn started after the store's last ending$/);
  });
});
