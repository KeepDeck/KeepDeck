import { describe, expect, it, vi } from "vitest";
import { sameSkillScope, skillScopeOf, type SkillScope } from "../domain/skills";
import { ipcSkillsStorage } from "../app/skillsLibrary";
import { deleteSkill, renameSkill, saveSkill } from "./skills";

const invoke = vi.hoisted(() =>
  vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
    async () => undefined,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const GLOBAL: SkillScope = { kind: "global" };
const WS: SkillScope = { kind: "workspace", wsId: "ws-1" };

/**
 * The seam where a scope becomes wire fields and back. Both halves of that
 * bijection are one edit apart from each other and live in different modules —
 * only the reverse half (`skillScopeOf`) had a test, so a change to the wire
 * values could have passed everything and met itself again only inside Rust.
 */
describe("a scope survives the round trip through the wire", () => {
  it("comes back as the same library, both kinds", async () => {
    for (const scope of [GLOBAL, WS]) {
      invoke.mockClear();
      await deleteSkill(scope, "review");
      const sent = invoke.mock.calls[0][1] as unknown as {
        scope: "global" | "workspace";
        wsId: string | null;
      };
      expect(sameSkillScope(skillScopeOf(sent), scope), scope.kind).toBe(true);
    }
  });

  it("sends a null workspace id for the global library, never an empty string", async () => {
    // An empty id is the domain's marker for a MALFORMED row; sending one would
    // manufacture exactly the thing `skillScopeOf` exists to keep out.
    invoke.mockClear();
    await deleteSkill(GLOBAL, "review");
    expect(invoke.mock.calls[0][1]).toMatchObject({ scope: "global", wsId: null });
  });
});

describe("the storage adapter maps each verb to its own command", () => {
  // Nothing else pins this: the library's suite injects a fake storage, and a
  // swapped field here (`rename: deleteSkill`) has the same signature, so it
  // would compile and only show up against the real backend.
  it("points at the command its name promises", async () => {
    expect(ipcSkillsStorage.save).toBe(saveSkill);
    expect(ipcSkillsStorage.rename).toBe(renameSkill);
    expect(ipcSkillsStorage.remove).toBe(deleteSkill);

    invoke.mockClear();
    await ipcSkillsStorage.remove(GLOBAL, "review");
    expect(invoke.mock.calls[0][0]).toBe("skills_delete");

    invoke.mockClear();
    await ipcSkillsStorage.rename(GLOBAL, "review", "deep-review");
    expect(invoke.mock.calls[0][0]).toBe("skills_rename");

    invoke.mockClear();
    await ipcSkillsStorage.save(GLOBAL, "review", "---\n---\n", true);
    expect(invoke.mock.calls[0][0]).toBe("skills_save");

    invoke.mockClear();
    await ipcSkillsStorage.fetch();
    expect(invoke.mock.calls[0][0]).toBe("skills_list");
  });
});
