import { describe, expect, it } from "vitest";
import {
  isValidCommandId,
  isValidCommandPattern,
  matchesAnyPattern,
  matchesPattern,
} from "./ids";

describe("isValidCommandId", () => {
  it("accepts namespaced ids", () => {
    expect(isValidCommandId("agent.spawn")).toBe(true);
    expect(isValidCommandId("workspace.switch")).toBe(true);
    expect(isValidCommandId("keepdeck.voice.listen")).toBe(true);
    expect(isValidCommandId("pane.writeText")).toBe(true);
  });

  it("rejects bare names — the first segment is the owner's namespace", () => {
    expect(isValidCommandId("spawn")).toBe(false);
  });

  it("rejects malformed segments", () => {
    expect(isValidCommandId("agent..spawn")).toBe(false);
    expect(isValidCommandId(".agent.spawn")).toBe(false);
    expect(isValidCommandId("agent.spawn.")).toBe(false);
    expect(isValidCommandId("Agent.spawn")).toBe(false);
    expect(isValidCommandId("agent.9spawn")).toBe(false);
    expect(isValidCommandId("agent.spa wn")).toBe(false);
    expect(isValidCommandId("")).toBe(false);
  });
});

describe("isValidCommandPattern", () => {
  it("accepts exact ids and namespace wildcards", () => {
    expect(isValidCommandPattern("agent.spawn")).toBe(true);
    expect(isValidCommandPattern("agent.*")).toBe(true);
    expect(isValidCommandPattern("keepdeck.voice.*")).toBe(true);
  });

  it("rejects a bare wildcard — all-commands access must name namespaces", () => {
    expect(isValidCommandPattern("*")).toBe(false);
    expect(isValidCommandPattern(".*")).toBe(false);
  });

  it("rejects infix wildcards", () => {
    expect(isValidCommandPattern("agent.*.spawn")).toBe(false);
  });
});

describe("matchesPattern", () => {
  it("matches exact ids", () => {
    expect(matchesPattern("agent.spawn", "agent.spawn")).toBe(true);
    expect(matchesPattern("agent.spawn", "agent.close")).toBe(false);
  });

  it("matches a namespace wildcard across the rest of the id", () => {
    expect(matchesPattern("agent.*", "agent.spawn")).toBe(true);
    expect(matchesPattern("agent.*", "agent.x.y")).toBe(true);
    expect(matchesPattern("agent.*", "workspace.switch")).toBe(false);
  });

  it("does not let a wildcard match a sibling namespace by prefix", () => {
    expect(matchesPattern("agent.*", "agents.list")).toBe(false);
  });
});

describe("matchesAnyPattern", () => {
  it("is true when any pattern covers the id", () => {
    expect(matchesAnyPattern(["run.*", "agent.spawn"], "agent.spawn")).toBe(true);
    expect(matchesAnyPattern(["run.*"], "agent.spawn")).toBe(false);
    expect(matchesAnyPattern([], "agent.spawn")).toBe(false);
  });
});
