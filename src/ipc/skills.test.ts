import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invoke-key contract with src-tauri/src/skills.rs. Every other skills
 * test mocks THIS module, so nothing else exercises the actual command
 * names and argument keys — and a silent key mismatch already shipped once
 * (`worktreeRoots` vs `roots`: every stage call failed, panes spawned
 * without skills). Same guard idiom as notify.test.ts: mock the tauri
 * boundary, run the real module, pin the exact wire calls. Keys here are
 * the camelCase forms Tauri maps onto the Rust params (wsId → ws_id) —
 * skills commands take TOP-LEVEL params (Tauri converts case), unlike
 * session_spawn's spec STRUCT (raw serde), whose pins live in
 * session.test.ts + session.rs. Copy the matching pattern when adding a
 * command.
 */
const tauri = vi.hoisted(() => ({
  // Signature declared so `mock.lastCall` is typed — the round-trip case below
  // reads the argument object back off it.
  invoke: vi.fn(
    async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => null,
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { sameSkillScope, skillScopeOf } from "../domain/skills";
import { ipcSkillsStorage } from "../app/skillsLibrary";
import {
  deleteSkill,
  disarmSkills,
  fetchSkills,
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
    await fetchSkills();
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_list");

    await saveSkill({ kind: "global" }, "review", "content", false);
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_save", {
      scope: "global",
      wsId: null,
      name: "review",
      content: "content",
      expectNew: false,
    });

    // A create says so, and the backend refuses a name already taken — the
    // guard that survives a library the dialog could not read.
    await saveSkill({ kind: "global" }, "fresh", "content", true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_save", {
      scope: "global",
      wsId: null,
      name: "fresh",
      content: "content",
      expectNew: true,
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

  it("stage degrades on a backend error; disarm and prune stay silent", async () => {
    tauri.invoke.mockRejectedValue(new Error("boom"));
    expect(await stageSkills("ws-1", [])).toBeNull();
    await disarmSkills(["/x"]); // must not throw
    await pruneSkills(["ws-1"]); // must not throw
  });

  it("the library read THROWS rather than degrading to an empty library", async () => {
    // There is deliberately no swallowing wrapper any more. "Empty" and
    // "unreadable" are different answers, and the create path's collision
    // check is derived from the list: reported as empty, every name looks
    // free and a create writes over the skill it collided with.
    tauri.invoke.mockRejectedValue(new Error("boom"));
    await expect(fetchSkills()).rejects.toThrow("boom");
  });

  it("save, delete and rename surface their failures", async () => {
    tauri.invoke.mockRejectedValue(new Error("boom"));
    await expect(saveSkill({ kind: "global" }, "x", "c", false)).rejects.toThrow(
      "boom",
    );
    await expect(deleteSkill({ kind: "global" }, "x")).rejects.toThrow("boom");
    await expect(renameSkill({ kind: "global" }, "a", "b")).rejects.toThrow("boom");
  });

  it("an empty disarm list never crosses the wire", async () => {
    await disarmSkills([]);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("a scope survives the round trip through the wire, both kinds", async () => {
    // `wire` here and `skillScopeOf` in the domain are exact inverses living in
    // different modules; only the reverse half had a test, so a change to the
    // wire values could have met itself again only inside Rust.
    for (const scope of [
      { kind: "global" },
      { kind: "workspace", wsId: "ws-1" },
    ] as const) {
      await deleteSkill(scope, "review");
      const sent = tauri.invoke.mock.lastCall?.[1] as {
        scope: "global" | "workspace";
        wsId: string | null;
      };
      expect(sameSkillScope(skillScopeOf(sent), scope), scope.kind).toBe(true);
    }
    // And the global arm sends null, never "" — an empty id is the domain's
    // marker for a MALFORMED row, so sending one would manufacture exactly the
    // thing `skillScopeOf` exists to keep out of every live library.
    await deleteSkill({ kind: "global" }, "review");
    expect(tauri.invoke.mock.lastCall?.[1]).toMatchObject({ wsId: null });
  });

  it("the storage adapter points each verb at the command its name promises", async () => {
    // Nothing else pins this: the library's suite injects a fake storage, so a
    // swapped field (`rename: deleteSkill`) has the same signature, compiles,
    // and shows up only against the real backend.
    expect(ipcSkillsStorage.save).toBe(saveSkill);
    expect(ipcSkillsStorage.rename).toBe(renameSkill);
    expect(ipcSkillsStorage.remove).toBe(deleteSkill);
  });

  it("the adapter reads the wire's scope columns into a scope, both kinds", async () => {
    // `fetch` is the one verb that is not a bare re-export: the DTO's
    // `scope`/`wsId` pair stops HERE, so nothing above the adapter carries the
    // wire's shape. This is the forward half of the round trip pinned above.
    tauri.invoke.mockResolvedValueOnce([
      { scope: "global", wsId: null, name: "review", content: "a" },
      { scope: "workspace", wsId: "ws-1", name: "review", content: "b" },
    ]);

    expect(await ipcSkillsStorage.fetch()).toEqual([
      { scope: { kind: "global" }, name: "review", content: "a" },
      { scope: { kind: "workspace", wsId: "ws-1" }, name: "review", content: "b" },
    ]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("skills_list");
  });
});
