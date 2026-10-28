import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createPluginWorkspaceDirs } from "./pluginWorkspaceDirs";

const workspace = (id: string): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: `/${id}`,
  worktreeBaseDir: null,
  panes: [],
});
const refOf = (ws: Workspace) => ({ id: ws.id, instance: ws.instance });

function setup(workspaces: Workspace[]) {
  const deps = {
    workspaces: () => workspaces,
    create: vi.fn(async (pluginId: string, wsId: string) => `/home/plugin-workspaces/${pluginId}/${wsId}`),
    prune: vi.fn(async (_live: readonly string[]) => {}),
    warn: vi.fn(),
  };
  return { deps, dirs: createPluginWorkspaceDirs(deps) };
}

describe("createPluginWorkspaceDirs", () => {
  it("hands a plugin its directory for a live workspace, made natively under its own id", async () => {
    const one = workspace("ws-1");
    const { deps, dirs } = setup([one]);
    expect(await dirs.forPlugin("keepdeck.claude").dir(refOf(one))).toBe("/home/plugin-workspaces/keepdeck.claude/ws-1");
    expect(deps.create).toHaveBeenCalledWith("keepdeck.claude", "ws-1");
  });

  it("refuses a workspace the deck does not hold under that lifetime", async () => {
    const one = workspace("ws-1");
    const { deps, dirs } = setup([one]);
    const stale = { id: "ws-1", instance: "an-earlier-life" };
    await expect(dirs.forPlugin("p").dir(stale)).rejects.toThrow('workspace "ws-1" is gone');
    await expect(dirs.forPlugin("p").dir({ id: "ws-9", instance: "x" })).rejects.toThrow("gone");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("prunes natively by the live ids", async () => {
    const { deps, dirs } = setup([workspace("ws-1"), workspace("ws-2")]);
    expect(await dirs.prune(["ws-2"])).toBe(true);
    expect(deps.prune).toHaveBeenCalledWith(["ws-2"]);
  });

  it("says a failed native prune, so the sweep tries again", async () => {
    const { deps, dirs } = setup([]);
    deps.prune.mockRejectedValueOnce(new Error("busy"));
    expect(await dirs.prune([])).toBe(false);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("busy"));
  });
});
