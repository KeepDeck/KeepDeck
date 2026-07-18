// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSkill } from "../ipc/skills";
import { useSkillsLibrary, type SkillsLibrary } from "./useSkills";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const wire = vi.hoisted(() => ({
  listSkills: vi.fn<() => Promise<StoredSkill[]>>(async () => []),
  saveSkill: vi.fn(async () => {}),
  deleteSkill: vi.fn(async () => {}),
  renameSkill: vi.fn(async () => {}),
}));
vi.mock("../ipc/skills", () => wire);

const staging = vi.hoisted(() => ({ invalidateSkillsStaging: vi.fn() }));
vi.mock("./skillsStaging", () => staging);

let lib: SkillsLibrary;
function Probe() {
  lib = useSkillsLibrary(true);
  return null;
}

describe("the skills library hook", () => {
  let root: Root;

  beforeEach(() => {
    wire.listSkills.mockClear();
    wire.saveSkill.mockClear();
    wire.deleteSkill.mockClear();
    wire.renameSkill.mockClear();
    staging.invalidateSkillsStaging.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = () => act(async () => root.render(createElement(Probe)));

  it("loads the library when opened", async () => {
    wire.listSkills.mockResolvedValue([
      { scope: "global", wsId: null, name: "review", content: "x" },
    ]);
    await mount();
    expect(lib.skills).toEqual([
      { scope: "global", wsId: null, name: "review", content: "x" },
    ]);
  });

  it("save composes the SKILL.md, invalidates staging, reloads", async () => {
    await mount();
    let ok = false;
    await act(async () => {
      ok = await lib.save(
        { kind: "global" },
        {
          name: "deploy",
          description: "Ships it",
          body: "Steps\n",
          extraFrontmatter: ["license: MIT"],
        },
      );
    });

    expect(ok).toBe(true);
    expect(wire.saveSkill).toHaveBeenCalledWith(
      { kind: "global" },
      "deploy",
      "---\nname: deploy\ndescription: Ships it\nlicense: MIT\n---\nSteps\n",
    );
    // The spawn side re-stages on the next spawn, and the list is fresh.
    expect(staging.invalidateSkillsStaging).toHaveBeenCalledTimes(1);
    expect(wire.listSkills).toHaveBeenCalledTimes(2);
  });

  it("a failed save surfaces the error and does NOT invalidate staging", async () => {
    wire.saveSkill.mockRejectedValueOnce(new Error("disk full"));
    await mount();
    let ok = true;
    await act(async () => {
      ok = await lib.save(
        { kind: "global" },
        { name: "x", description: "", body: "", extraFrontmatter: [] },
      );
    });

    expect(ok).toBe(false);
    expect(lib.error).toContain("disk full");
    expect(staging.invalidateSkillsStaging).not.toHaveBeenCalled();
  });

  it("rename moves the skill, invalidates staging, reloads", async () => {
    await mount();
    let ok = false;
    await act(async () => {
      ok = await lib.rename({ kind: "global" }, "review", "deep-review");
    });

    expect(ok).toBe(true);
    expect(wire.renameSkill).toHaveBeenCalledWith(
      { kind: "global" },
      "review",
      "deep-review",
    );
    expect(staging.invalidateSkillsStaging).toHaveBeenCalledTimes(1);
  });

  it("a failed rename surfaces the error and leaves staging alone", async () => {
    wire.renameSkill.mockRejectedValueOnce(new Error("already exists"));
    await mount();
    let ok = true;
    await act(async () => {
      ok = await lib.rename({ kind: "global" }, "a", "b");
    });

    expect(ok).toBe(false);
    expect(lib.error).toContain("already exists");
    expect(staging.invalidateSkillsStaging).not.toHaveBeenCalled();
  });

  it("remove deletes, invalidates staging, reloads", async () => {
    await mount();
    await act(async () => {
      await lib.remove({ kind: "workspace", wsId: "ws-2" }, "review");
    });

    expect(wire.deleteSkill).toHaveBeenCalledWith(
      { kind: "workspace", wsId: "ws-2" },
      "review",
    );
    expect(staging.invalidateSkillsStaging).toHaveBeenCalledTimes(1);
  });
});
