import { describe, expect, it, vi } from "vitest";
import { createArmRefusalStore } from "./armRefusals";

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

  it("keeps only the refusals of folders panes still run in", () => {
    const store = createArmRefusalStore();
    store.record("kimi", "/a", [{ path: "p", reason: "r" }]);
    store.record("codex", "/b", [{ path: "q", reason: "r" }]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.retain(new Set(["/b", "/c"]));
    expect(store.get().map((r) => r.cwd)).toEqual(["/b"]);
    // Nothing more to drop: nobody is told twice.
    store.retain(new Set(["/b"]));
    expect(listener).toHaveBeenCalledTimes(1);
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
