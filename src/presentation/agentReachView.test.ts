import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../domain/agents";
import { agentLabelList, mcpReachHint, remoteAgentsHint, skillsReachHint } from "./agentReachView";

const agent = (id: string, label: string, features: string[]): AgentInfo => ({
  id,
  label,
  command: id,
  features: features.map((feature) => ({ id: feature, label: feature })),
  installed: true,
  path: null,
});
const alpha = agent("alpha", "Alpha", ["integration.mcp", "integration.skills", "target.remote"]);
const beta = agent("beta", "Beta", ["integration.mcp"]);
const gamma = agent("gamma", "Gamma", ["integration.mcp", "integration.skills", "target.remote"]);

describe("agentLabelList", () => {
  it("names none, one, two and many agents the way a sentence does", () => {
    expect(agentLabelList([])).toBe("");
    expect(agentLabelList([alpha])).toBe("Alpha");
    expect(agentLabelList([alpha, beta])).toBe("Alpha and Beta");
    expect(agentLabelList([alpha, beta, gamma])).toBe("Alpha, Beta and Gamma");
  });
});

describe("library reach hints", () => {
  it("name only the agents whose plugin declares the library, in catalog order", () => {
    expect(mcpReachHint([alpha, beta, gamma])).toContain("reaches Alpha, Beta and Gamma panes");
    expect(skillsReachHint([alpha, beta, gamma])).toContain("reaches Alpha and Gamma worktrees");
  });

  it("say so when no agent takes the library", () => {
    expect(mcpReachHint([])).toContain("no installed agent takes MCP servers");
    expect(skillsReachHint([beta])).toContain("no installed agent takes skills");
  });
});

describe("remoteAgentsHint", () => {
  it("names the agents that declare a remote target, and drops the aside when none does", () => {
    expect(remoteAgentsHint([alpha, beta])).toContain("protocol (Alpha) run");
    expect(remoteAgentsHint([alpha, beta, gamma])).toContain("(Alpha and Gamma)");
    expect(remoteAgentsHint([beta])).toContain("protocol run against");
  });
});
