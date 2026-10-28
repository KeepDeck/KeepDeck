import { describe, expect, it, vi } from "vitest";
import { createArmRefusalStore } from "./armRefusals";
import { createCwdArming } from "./cwdArming";

describe("createArmRefusalStore", () => {
  it("replaces what it said about one agent in one folder, and keeps the rest", () => {
    const store = createArmRefusalStore();
    store.record("kimi", "/a", [{ path: ".k/mcp.json", reason: "yours" }]);
    store.record("codex", "/a", [{ path: ".agents/skills", reason: "yours" }]);
    store.record("kimi", "/b", [{ path: ".k/mcp.json", reason: "gone" }]);
    // The user moved their file away in /a: kimi's next pass there plants.
    store.record("kimi", "/a", []);
    expect(store.get()).toEqual([
      { agentId: "codex", cwd: "/a", path: ".agents/skills", reason: "yours" },
      { agentId: "kimi", cwd: "/b", path: ".k/mcp.json", reason: "gone" },
    ]);
  });

  it("forgets every refusal of a folder taken back whole", () => {
    const store = createArmRefusalStore();
    store.record("kimi", "/a", [{ path: "p", reason: "r" }]);
    store.record("codex", "/b", [{ path: "q", reason: "r" }]);
    store.forget(["/a"]);
    expect(store.get().map((r) => r.cwd)).toEqual(["/b"]);
  });

  it("tells listeners only when what it says changed — by content", () => {
    const store = createArmRefusalStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.record("kimi", "/a", [{ path: "p", reason: "r" }]);
    store.record("kimi", "/a", [{ path: "p", reason: "r" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.record("kimi", "/a", [{ path: "p", reason: "another" }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("createCwdArming", () => {
  it("plants through the worktree owner and records what was refused under the agent", async () => {
    const armCwd = vi.fn(async () => ({ armed: ["a"], refused: [{ path: "b", reason: "yours" }] }));
    const record = vi.fn();
    const arm = createCwdArming({ worktrees: { armCwd }, refusals: { record } });
    const request = { pluginId: "p", workspaceId: "ws-1", cwd: "/repo", arms: [], skillsDir: null };
    await arm("kimi", request);
    expect(armCwd).toHaveBeenCalledWith(request);
    expect(record).toHaveBeenCalledWith("kimi", "/repo", [{ path: "b", reason: "yours" }]);
  });
});
