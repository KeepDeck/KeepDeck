import { describe, expect, it } from "vitest";
import {
  normalizeAgents,
  resumeArgs,
  selectableAgents,
  defaultAgentType,
  FALLBACK_AGENTS,
  type AgentInfo,
} from "./agents";

/** Terse AgentInfo builder for tests. */
function agent(
  id: AgentInfo["id"],
  installed: boolean,
  extra: Partial<AgentInfo> = {},
): AgentInfo {
  return { id, label: id, command: id, installed, path: null, ...extra };
}

describe("normalizeAgents", () => {
  it("passes a non-empty catalog through unchanged", () => {
    const list = [agent("claude", true)];
    expect(normalizeAgents(list)).toBe(list);
  });

  it("falls back to the static catalog for empty / missing input", () => {
    for (const empty of [[], null, undefined]) {
      const out = normalizeAgents(empty as AgentInfo[] | null | undefined);
      expect(out.map((a) => a.id)).toEqual(["claude", "opencode", "codex"]);
    }
  });
});

describe("resumeArgs ([F8])", () => {
  it("builds prefix + session id per agent (the verified recipes)", () => {
    const byId = (id: AgentInfo["id"]) =>
      FALLBACK_AGENTS.find((a) => a.id === id);
    expect(resumeArgs(byId("claude"), "abc")).toEqual(["--resume", "abc"]);
    expect(resumeArgs(byId("codex"), "abc")).toEqual(["resume", "abc"]);
    expect(resumeArgs(byId("opencode"), "abc")).toEqual(["-s", "abc"]);
  });

  it("returns null without a recipe — the caller spawns fresh, not guessed", () => {
    expect(resumeArgs(undefined, "abc")).toBeNull();
    expect(resumeArgs(agent("claude", true), "abc")).toBeNull();
    expect(resumeArgs(agent("claude", true, { resumePrefix: [] }), "abc")).toBeNull();
  });
});

describe("selectableAgents", () => {
  it("keeps only installed agents when some are installed", () => {
    const list = [
      agent("claude", false),
      agent("opencode", true),
      agent("codex", false),
    ];
    expect(selectableAgents(list).map((a) => a.id)).toEqual(["opencode"]);
  });

  it("falls back to the full list when none are installed (never lock out)", () => {
    const list = [agent("claude", false), agent("codex", false)];
    expect(selectableAgents(list)).toBe(list);
  });
});

describe("defaultAgentType", () => {
  const list = [
    agent("claude", false),
    agent("opencode", true),
    agent("codex", true),
  ];

  it("keeps the preferred type when it is still selectable", () => {
    expect(defaultAgentType(list, "codex")).toBe("codex");
  });

  it("drops a preferred type that is not installed, to the first installed", () => {
    // "claude" is not installed → snap to the first selectable ("opencode").
    expect(defaultAgentType(list, "claude")).toBe("opencode");
  });

  it("uses the first installed agent when no preference is given", () => {
    expect(defaultAgentType(list)).toBe("opencode");
  });

  it("falls back to claude when the catalog is empty (pre-load)", () => {
    expect(defaultAgentType([])).toBe("claude");
    expect(defaultAgentType([], "codex")).toBe("claude");
  });

  it("prefers within the full list when nothing is installed", () => {
    const none = [agent("claude", false), agent("codex", false)];
    // selectableAgents falls back to the full list, so a preference still holds.
    expect(defaultAgentType(none, "codex")).toBe("codex");
    expect(defaultAgentType(none)).toBe("claude");
  });
});
