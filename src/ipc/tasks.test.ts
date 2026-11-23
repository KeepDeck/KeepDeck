import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The board write's wire (integration rows B12 and B26): `tasks_apply`
 * takes who made the change beside the change, and the store refuses a
 * writer the lifecycle has forgotten under its own lock. The writer crosses
 * as the Rust `Source` spells it — `workspaceId`, `team`, `pane`.
 */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => ({})),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { tasksApply } from "./tasks";

describe("tasks_apply", () => {
  beforeEach(() => tauri.invoke.mockClear());

  it("sends the writer beside the change, as the store's door reads it", async () => {
    const change = { requestId: "r-1", boards: [] };
    await tasksApply({ workspace: "ws-1", team: "team-1", pane: "pane-1" }, change);
    expect(tauri.invoke).toHaveBeenCalledWith("tasks_apply", {
      source: { workspaceId: "ws-1", team: "team-1", pane: "pane-1" },
      change,
    });
  });

  it("a person's write names the workspace alone", async () => {
    const change = { requestId: "r-2", boards: [] };
    await tasksApply({ workspace: "ws-1" }, change);
    expect(tauri.invoke).toHaveBeenCalledWith("tasks_apply", {
      source: { workspaceId: "ws-1", team: null, pane: null },
      change,
    });
  });
});
