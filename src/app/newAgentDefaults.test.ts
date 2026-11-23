import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  current: null as { defaultAgent?: string; defaultYolo?: boolean } | null,
}));
vi.mock("./settingsManager", () => ({ getSettings: () => settings.current }));

import type { AgentInfo } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { nextAgentType, nextYolo } from "./newAgentDefaults";

const agent = (id: string): AgentInfo => ({
  id,
  label: id,
  command: id,
  features: [{ id: "session.new", label: "New sessions" }],
  installed: true,
  path: "/bin",
});
const AGENTS = [agent("claude"), agent("codex")];

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "deck",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

beforeEach(() => {
  settings.current = null;
});

describe("nextAgentType", () => {
  it("follows the workspace's own momentum before anything else", () => {
    settings.current = { defaultAgent: "claude" };
    expect(
      nextAgentType(AGENTS, ws({ panes: [{ id: "p1", agentType: "codex" }] })),
    ).toBe("codex");
  });

  it("falls to the global preference when the workspace has no panes", () => {
    settings.current = { defaultAgent: "codex" };
    expect(nextAgentType(AGENTS, ws())).toBe("codex");
  });

  it("falls to the first installed agent when neither says anything", () => {
    // Claude is deliberately absent: with it installed the chain's own
    // "claude" literal answers, and the test would pass whether or not the
    // first-installed rule existed at all.
    expect(nextAgentType([agent("codex"), agent("opencode")], ws())).toBe(
      "codex",
    );
  });

  it("ignores momentum toward an agent no plugin provides any more", () => {
    // The last pane ran a since-removed agent; prefilling it would open the
    // dialog on a type the user cannot create.
    expect(
      nextAgentType(AGENTS, ws({ panes: [{ id: "p1", agentType: "retired" }] })),
    ).toBe("claude");
  });

  it("names no agent when no plugin provides one, whatever the momentum or the preference", () => {
    settings.current = { defaultAgent: "claude" };
    expect(nextAgentType([], ws({ panes: [{ id: "p1", agentType: "codex" }] }))).toBeNull();
  });

  it("reads the preference at the moment of asking, not at boot", () => {
    settings.current = { defaultAgent: "codex" };
    expect(nextAgentType(AGENTS, ws())).toBe("codex");
    settings.current = { defaultAgent: "claude" };
    expect(nextAgentType(AGENTS, ws())).toBe("claude");
  });
});

describe("nextYolo", () => {
  it("starts a fresh agent from the global preference, read when asked", () => {
    expect(nextYolo()).toBe(false);
    settings.current = { defaultYolo: true };
    expect(nextYolo()).toBe(true);
  });
});
