import { describe, expect, it } from "vitest";
import {
  agentRemoteSchemes,
  agentSupportsRemote,
  agentSupportsYolo,
  remoteValid,
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

describe("agentSupportsRemote", () => {
  const list = [
    agent("codex", true, { supportsRemote: true }),
    agent("claude", true),
  ];

  it("answers from the catalog entry, false for non-support and unknowns", () => {
    expect(agentSupportsRemote(list, "codex")).toBe(true);
    expect(agentSupportsRemote(list, "claude")).toBe(false);
    // An absent agent must never be offered a remote target.
    expect(agentSupportsRemote(list, "kimi")).toBe(false);
    expect(agentSupportsRemote([], "codex")).toBe(false);
  });
});

describe("agentRemoteSchemes", () => {
  const list = [
    agent("codex", true, {
      supportsRemote: true,
      remoteSchemes: ["ws", "wss"],
    }),
    // Declares remote but with NO schemes — a malformed contribution. The
    // selector returns null so the dialog's Where option hides (Create could
    // never enable with no schemes to validate against).
    agent("buggy", true, { supportsRemote: true, remoteSchemes: [] }),
    agent("claude", true),
  ];

  it("returns the schemes for a remote agent, null for local/unknown", () => {
    expect(agentRemoteSchemes(list, "codex")).toEqual(["ws", "wss"]);
    expect(agentRemoteSchemes(list, "claude")).toBeNull();
    expect(agentRemoteSchemes(list, "nope")).toBeNull();
    expect(agentRemoteSchemes([], "codex")).toBeNull();
  });

  it("returns null for a remote declaration with empty schemes (fails safe)", () => {
    expect(agentRemoteSchemes(list, "buggy")).toBeNull();
  });
});

describe("remoteValid", () => {
  const codex = ["ws", "wss"];
  const opencode = ["http", "https"];

  it("accepts a matching scheme with a host", () => {
    expect(remoteValid("ws://vps:4500", codex)).toBe(true);
    expect(remoteValid("http://vps:4096", opencode)).toBe(true);
  });

  it("rejects a scheme the agent does not speak", () => {
    expect(remoteValid("http://vps:4096", codex)).toBe(false);
    expect(remoteValid("ws://vps:4500", opencode)).toBe(false);
    expect(remoteValid("ftp://vps", codex)).toBe(false);
  });

  it("rejects hostless / garbage / null-schemes", () => {
    expect(remoteValid("ws://:4500", codex)).toBe(false);
    expect(remoteValid("not a url", codex)).toBe(false);
    expect(remoteValid("ws://vps:4500", null)).toBe(false);
    expect(remoteValid("ws://vps:4500", [])).toBe(false);
  });
});
