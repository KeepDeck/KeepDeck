import { describe, expect, it } from "vitest";
import {
  agentSupportsYolo,
  selectableAgents,
  defaultAgentType,
  type AgentInfo,
} from "./agents";

/** Terse AgentInfo builder for tests. */
function agent(
  id: AgentInfo["id"],
  installed: boolean,
  extra: Partial<AgentInfo> = {},
): AgentInfo {
  return {
    id,
    label: id,
    command: id,
    supportsYolo: false,
    usageCapabilities: ["paneTelemetry", "accountLimits"],
    installed,
    path: null,
    ...extra,
  };
}

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

describe("agentSupportsYolo", () => {
  const list = [
    agent("claude", true, { supportsYolo: true }),
    agent("codex", true),
  ];

  it("answers from the catalog entry, false for non-support and unknowns", () => {
    expect(agentSupportsYolo(list, "claude")).toBe(true);
    expect(agentSupportsYolo(list, "codex")).toBe(false);
    // An absent agent (plugin gone, catalog loading) must never arm YOLO.
    expect(agentSupportsYolo(list, "gemini")).toBe(false);
    expect(agentSupportsYolo([], "claude")).toBe(false);
  });
});
