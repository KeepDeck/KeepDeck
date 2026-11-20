import { describe, expect, it, vi } from "vitest";
import type { Reply } from "../ipc/generated/lifecycle/Reply";
import { refusalText } from "../presentation/lifecycleWords";
import { createCwdArming } from "./cwdArming";

const REQUEST = {
  pluginId: "p",
  workspaceId: "ws-a",
  cwd: "/wt/a",
  arms: [{ kind: "file" as const, path: ".agent/conf", content: "{}" }],
  skillsDir: null,
};

function rig(reply: Reply) {
  const order: string[] = [];
  const deps = {
    worktrees: {
      armCwd: vi.fn(async () => {
        order.push("arm");
        return { armed: [".agent/conf"], refused: [] };
      }),
    },
    refusals: { record: vi.fn() },
    lease: vi.fn(async () => {
      order.push("lease");
      return reply;
    }),
    release: vi.fn(async () => {
      order.push("release");
    }),
  };
  return { deps, order, arm: createCwdArming(deps) };
}

describe("createCwdArming", () => {
  it("plants only under the folder's arm lease, and lets the lease go once it is done", async () => {
    const r = rig({ kind: "answered", answer: { kind: "leased", permit: 5 } });
    await r.arm("agent-a", REQUEST);
    expect(r.deps.lease).toHaveBeenCalledWith({ kind: "arm", workspace: "ws-a", dir: "/wt/a" });
    expect(r.order).toEqual(["lease", "arm", "release"]);
    expect(r.deps.release).toHaveBeenCalledWith(5);
    expect(r.deps.refusals.record).toHaveBeenCalledWith("agent-a", "/wt/a", []);
  });

  it("plants nothing in a folder the machine will not lease, and says why for every path", async () => {
    const r = rig({ kind: "answered", answer: { kind: "refused", refusal: { kind: "targetLeaving" } } });
    await r.arm("agent-a", REQUEST);
    expect(r.deps.worktrees.armCwd).not.toHaveBeenCalled();
    expect(r.deps.release).not.toHaveBeenCalled();
    expect(r.deps.refusals.record).toHaveBeenCalledWith("agent-a", "/wt/a", [
      { path: ".agent/conf", reason: refusalText({ kind: "targetLeaving" }) },
    ]);
  });

  it("lets the lease go even when the planting throws", async () => {
    const r = rig({ kind: "answered", answer: { kind: "leased", permit: 6 } });
    r.deps.worktrees.armCwd.mockRejectedValueOnce(new Error("disk"));
    await expect(r.arm("agent-a", REQUEST)).rejects.toThrow("disk");
    expect(r.deps.release).toHaveBeenCalledWith(6);
  });
});
