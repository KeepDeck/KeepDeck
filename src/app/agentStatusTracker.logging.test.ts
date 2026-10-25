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
const record = (edge: AgentStatusEvent, body: string) => ({ agent: "x", kind: "store.record", record: { body }, edge });

describe("the tracker's account of a pane's status", () => {
  beforeEach(() => {
    lines.length = 0;
  });

  it("logs each transition with its edge, source time and cause — a few lines per turn, no record body", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("x", edgeOf);
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
