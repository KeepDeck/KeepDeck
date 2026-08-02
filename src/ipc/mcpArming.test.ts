import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("./log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { mcpArm, mcpDisarm, mcpPrune } from "./mcpArming";

beforeEach(() => {
  tauri.invoke.mockReset();
});

describe("the MCP arming wrappers", () => {
  it("names the backend commands and their argument shapes", async () => {
    // The wire is the whole job of this module: a renamed key fails only
    // here, at runtime, in a path no other test exercises.
    tauri.invoke.mockResolvedValue({ armed: ["/repo"], refused: [] });
    await mcpArm("ws-1", [{ root: "/repo", content: "{}" }]);
    expect(tauri.invoke).toHaveBeenCalledWith("mcp_arm", {
      wsId: "ws-1",
      entries: [{ root: "/repo", content: "{}" }],
    });

    tauri.invoke.mockResolvedValue(undefined);
    await mcpDisarm(["/repo"]);
    expect(tauri.invoke).toHaveBeenCalledWith("mcp_disarm", {
      roots: ["/repo"],
    });

    await mcpPrune(["ws-1"]);
    expect(tauri.invoke).toHaveBeenCalledWith("mcp_prune", {
      liveWsIds: ["ws-1"],
    });
  });

  it("degrades a failed arming to 'nothing was planted'", async () => {
    // The pane then spawns without KeepDeck's servers — the same outcome as
    // the transport being off, never a dead spawn.
    tauri.invoke.mockRejectedValue(new Error("no home directory"));
    expect(await mcpArm("ws-1", [{ root: "/repo", content: "{}" }])).toEqual({
      armed: [],
      refused: [],
    });
  });

  it("reports whether a sweep got through, so a failed pass is not recorded as done", async () => {
    tauri.invoke.mockRejectedValue(new Error("backend gone"));
    expect(await mcpDisarm(["/repo"])).toBe(false);
    expect(await mcpPrune(["ws-1"])).toBe(false);

    tauri.invoke.mockResolvedValue(undefined);
    expect(await mcpDisarm(["/repo"])).toBe(true);
    expect(await mcpPrune(["ws-1"])).toBe(true);
  });

  it("asks for nothing when there is nothing to disarm", async () => {
    expect(await mcpDisarm([])).toBe(true);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
