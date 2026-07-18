import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invoke-key contract with src-tauri/src/skills.rs. Every other skills
 * test mocks THIS module, so nothing else exercises the actual command
 * names and argument keys — and a silent key mismatch already shipped once
 * (`worktreeRoots` vs `roots`: every stage call failed, panes spawned
 * without skills). Same guard idiom as notify.test.ts: mock the tauri
 * boundary, run the real module, pin the exact wire calls. Keys here are
 * the camelCase forms Tauri maps onto the Rust params (wsId → ws_id).
 */
const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import {
  deleteSkill,
  disarmSkills,
  listSkills,
  pruneSkills,
  renameSkill,
  saveSkill,
  stageSkills,
} from "./skills";

describe("the skills invoke-key contract", () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
    tauri.invoke.mockResolvedValue(null);
  });

  it("pins every command name and argument key", async () => {
    tauri.invoke.mockResolvedValueOnce([]);
    await listSkills();
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_list");

    await saveSkill({ kind: "global" }, "review", "content");
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_save", {
      scope: "global",
      wsId: null,
      name: "review",
      content: "content",
    });

    await deleteSkill({ kind: "workspace", wsId: "ws-2" }, "review");
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_delete", {
      scope: "workspace",
      wsId: "ws-2",
      name: "review",
    });

    await renameSkill({ kind: "global" }, "old", "new");
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_rename", {
      scope: "global",
      wsId: null,
      from: "old",
      to: "new",
    });

    await stageSkills("ws-1", ["/cwd/a"]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_stage", {
      wsId: "ws-1",
      roots: ["/cwd/a"],
    });

    await disarmSkills(["/cwd/a"]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_disarm", {
      roots: ["/cwd/a"],
    });

    await pruneSkills(["ws-1"]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_prune", {
      liveWsIds: ["ws-1"],
    });
  });

  it("list and stage degrade on a backend error; disarm and prune stay silent", async () => {
    tauri.invoke.mockRejectedValue(new Error("boom"));
    expect(await listSkills()).toEqual([]);
    expect(await stageSkills("ws-1", [])).toBeNull();
    await disarmSkills(["/x"]); // must not throw
    await pruneSkills(["ws-1"]); // must not throw
  });

  it("save, delete and rename surface their failures", async () => {
    tauri.invoke.mockRejectedValue(new Error("boom"));
    await expect(saveSkill({ kind: "global" }, "x", "c")).rejects.toThrow("boom");
    await expect(deleteSkill({ kind: "global" }, "x")).rejects.toThrow("boom");
    await expect(renameSkill({ kind: "global" }, "a", "b")).rejects.toThrow("boom");
  });

  it("an empty disarm list never crosses the wire", async () => {
    await disarmSkills([]);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
