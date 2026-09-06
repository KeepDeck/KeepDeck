import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worktree wire, at the IPC seam: what `worktree_create` is SENT. The
 * Rust side deserializes `CreateSpec` by field name, so the one thing this
 * file pins is the name of the owner field — a mismatch fails every create
 * at runtime and nowhere at compile time.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { createWorktree } from "./worktree";

beforeEach(() => {
  tauri.invoke.mockReset();
});

describe("createWorktree", () => {
  it("sends the spec under `ownerId` — the team's — and never an agent id", async () => {
    tauri.invoke.mockResolvedValue({ path: "/wt/1", branch: "kd/ws/1" });

    const record = await createWorktree({
      repo: "/repo",
      ownerId: "team-1",
      branch: "kd/ws/1",
      base: "abc123",
      workspace: "ws",
      index: 1,
      path: "/wt/1",
    });

    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("worktree_create");
    const spec = (args as { spec: Record<string, unknown> }).spec;
    expect(spec.ownerId).toBe("team-1");
    expect(spec).not.toHaveProperty("agentId");
    expect(spec).toMatchObject({ repo: "/repo", path: "/wt/1", branch: "kd/ws/1" });
    // The record is the directory and the branch — no owner rides back.
    expect(record).toEqual({ path: "/wt/1", branch: "kd/ws/1" });
  });
});
