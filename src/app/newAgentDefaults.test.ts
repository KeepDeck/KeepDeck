import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  current: null as { defaultAgent?: string } | null,
}));
vi.mock("./settingsManager", () => ({ getSettings: () => settings.current }));

const ipc = vi.hoisted(() => ({
  suggestWorktree: vi.fn(),
  probeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => ipc);

import type { AgentInfo } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  firstFreeAgentWorktree,
  nextAgentIndex,
  nextAgentType,
} from "./newAgentDefaults";

const agent = (id: string): AgentInfo => ({
  id,
  label: id,
  command: id,
  supportsYolo: false,
  installed: true,
  path: "/bin",
  usageCapabilities: ["paneTelemetry", "accountLimits"],
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
  ipc.suggestWorktree
    .mockReset()
    .mockImplementation(async (name: string, index: number) => ({
      branch: `kd/${name}/${index}`,
      folder: `kd-${name}-${index}`,
    }));
  ipc.probeWorktree.mockReset().mockResolvedValue({
    exists: false,
    isWorktree: false,
    empty: false,
    branch: null,
  });
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
    expect(nextAgentType(AGENTS, ws())).toBe("claude");
  });

  it("ignores momentum toward an agent no plugin provides any more", () => {
    // The last pane ran a since-removed agent; prefilling it would open the
    // dialog on a type the user cannot create.
    expect(
      nextAgentType(AGENTS, ws({ panes: [{ id: "p1", agentType: "retired" }] })),
    ).toBe("claude");
  });

  it("reads the preference at the moment of asking, not at boot", () => {
    settings.current = { defaultAgent: "codex" };
    expect(nextAgentType(AGENTS, ws())).toBe("codex");
    settings.current = { defaultAgent: "claude" };
    expect(nextAgentType(AGENTS, ws())).toBe("claude");
  });
});

describe("nextAgentIndex", () => {
  it("is the pane's position, the input to its auto branch name", () => {
    expect(nextAgentIndex(ws())).toBe(1);
    expect(
      nextAgentIndex(ws({ panes: [{ id: "a" }, { id: "b" }] })),
    ).toBe(3);
  });
});

describe("firstFreeAgentWorktree", () => {
  it("suggests nothing when the workspace has no base folder", async () => {
    expect(await firstFreeAgentWorktree([ws()], ws(), 1)).toBeNull();
    expect(ipc.suggestWorktree).not.toHaveBeenCalled();
  });

  it("skips a location an open pane already runs in", async () => {
    const workspace = ws({
      worktreeBaseDir: "/wt",
      panes: [{ id: "p1", cwd: "/wt/kd-deck-1" }],
    });
    expect(await firstFreeAgentWorktree([workspace], workspace, 1)).toEqual({
      path: "/wt/kd-deck-2",
      branch: "kd/deck/2",
    });
  });

  it("skips a folder that exists on disk with no pane behind it", async () => {
    // A worktree removed outside the app leaves the directory; opening onto
    // it would land the dialog on a blocked-path error.
    ipc.probeWorktree.mockImplementation(async (path: string) => ({
      exists: path === "/wt/kd-deck-1",
      isWorktree: false,
      empty: false,
      branch: null,
    }));
    const workspace = ws({ worktreeBaseDir: "/wt" });
    expect(await firstFreeAgentWorktree([workspace], workspace, 1)).toEqual({
      path: "/wt/kd-deck-2",
      branch: "kd/deck/2",
    });
  });

  it("treats a failing suggestion as no prefill, not an error", async () => {
    ipc.suggestWorktree.mockRejectedValue(new Error("ipc down"));
    const workspace = ws({ worktreeBaseDir: "/wt" });
    await expect(
      firstFreeAgentWorktree([workspace], workspace, 1),
    ).resolves.toBeNull();
  });

  it("does not let a failing PROBE filter out a usable suggestion", async () => {
    // A probe that rejects is IPC trouble, not a missing path — degrading to
    // "offer it anyway" keeps the dialog usable.
    ipc.probeWorktree.mockRejectedValue(new Error("ipc down"));
    const workspace = ws({ worktreeBaseDir: "/wt" });
    expect(await firstFreeAgentWorktree([workspace], workspace, 1)).toEqual({
      path: "/wt/kd-deck-1",
      branch: "kd/deck/1",
    });
  });
});
