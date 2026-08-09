// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSkill } from "../ipc/skills";
import { useSkillsLibrary, type SkillsLibraryView } from "./useSkills";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Driven over a FAKE library: what the hook owns is view state — loaded vs
 * in-flight, the error in words, and when a stale list beats a blank one.
 * Composing a SKILL.md, refusing a bad draft and invalidating the staged views
 * belong to `skillsLibrary` and are covered by its own suite; asserting them
 * again through React would be the same rule pinned twice.
 */
const library = vi.hoisted(() => ({
  list: vi.fn<() => Promise<StoredSkill[]>>(async () => []),
  create: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ skills: library }),
}));

const STORED: StoredSkill = {
  scope: "global",
  wsId: null,
  name: "review",
  content: "x",
};
const DRAFT = { name: "deploy", description: "Ships it", body: "", extraFrontmatter: [] };

let view: SkillsLibraryView;
function Probe() {
  view = useSkillsLibrary(true);
  return null;
}

describe("the skills library hook", () => {
  let root: Root;

  beforeEach(() => {
    for (const fn of Object.values(library)) fn.mockClear();
    library.list.mockResolvedValue([]);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = () => act(async () => root.render(createElement(Probe)));

  it("loads the library when opened", async () => {
    library.list.mockResolvedValue([STORED]);
    await mount();
    expect(view.skills).toEqual([STORED]);
    expect(view.error).toBeNull();
  });

  it("reports an unreadable library instead of showing it empty", async () => {
    library.list.mockRejectedValueOnce(new Error("backend down"));
    await mount();
    // The empty list is what the editor can render; the error is the only
    // thing on screen saying the library is unknown rather than empty.
    expect(view.skills).toEqual([]);
    expect(view.error).toContain("backend down");
  });

  it("routes a create and an update to the right library call", async () => {
    // The only decision this binding makes: the dialog's create/edit mode.
    await mount();
    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, true);
    });
    expect(library.create).toHaveBeenCalledWith({ kind: "global" }, DRAFT);
    expect(library.update).not.toHaveBeenCalled();

    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, false);
    });
    expect(library.update).toHaveBeenCalledWith({ kind: "global" }, DRAFT);
  });

  it("reloads after a successful save", async () => {
    await mount();
    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, false);
    });
    // The dialog's initial load, then the post-save reload.
    expect(library.list).toHaveBeenCalledTimes(2);
  });

  it("a successful save whose reload fails keeps the stale list", async () => {
    library.list.mockResolvedValue([STORED]);
    await mount();
    library.list.mockRejectedValueOnce(new Error("transient"));

    let ok = false;
    await act(async () => {
      ok = await view.save({ kind: "global" }, DRAFT, false);
    });

    expect(ok).toBe(true); // the write itself landed
    expect(view.skills).toHaveLength(1); // stale beats blank
    expect(view.error).toBeNull();
  });

  it("a failed save surfaces the error and keeps the list truthful", async () => {
    library.list.mockResolvedValue([STORED]);
    library.create.mockRejectedValueOnce(new Error("disk full"));
    await mount();

    let ok = true;
    await act(async () => {
      ok = await view.save({ kind: "global" }, DRAFT, true);
    });

    expect(ok).toBe(false);
    expect(view.error).toContain("disk full");
    // Re-read even on failure: a rename may have moved the disk under this
    // action. The error the user is reading must survive it.
    expect(view.skills).toHaveLength(1);
  });

  it("a failed save whose re-read also fails keeps the stale list", async () => {
    library.list.mockResolvedValue([STORED]);
    await mount();
    library.create.mockRejectedValueOnce(new Error("down"));
    library.list.mockRejectedValueOnce(new Error("still down"));

    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, true);
    });

    expect(view.skills).toHaveLength(1);
    expect(view.error).toContain("down");
  });

  it("rename leaves the reload to the save that follows", async () => {
    await mount();
    let ok = false;
    await act(async () => {
      ok = await view.rename({ kind: "global" }, "review", "deep-review");
    });

    expect(ok).toBe(true);
    expect(library.rename).toHaveBeenCalledWith({ kind: "global" }, "review", "deep-review");
    // One user action, one reload: only the dialog's initial load has happened.
    expect(library.list).toHaveBeenCalledTimes(1);
  });

  it("a failed rename surfaces the error", async () => {
    library.rename.mockRejectedValueOnce(new Error("already exists"));
    await mount();
    let ok = true;
    await act(async () => {
      ok = await view.rename({ kind: "global" }, "a", "b");
    });

    expect(ok).toBe(false);
    expect(view.error).toContain("already exists");
  });

  it("remove reloads, and a failure keeps the list", async () => {
    await mount();
    await act(async () => {
      await view.remove({ kind: "workspace", wsId: "ws-2" }, "review");
    });
    expect(library.remove).toHaveBeenCalledWith({ kind: "workspace", wsId: "ws-2" }, "review");
    expect(library.list).toHaveBeenCalledTimes(2);

    library.remove.mockRejectedValueOnce(new Error("busy"));
    await act(async () => {
      await view.remove({ kind: "global" }, "review");
    });
    expect(view.error).toContain("busy");
  });

  it("clearError drops the notice when the user navigates away", async () => {
    library.list.mockRejectedValueOnce(new Error("backend down"));
    await mount();
    expect(view.error).not.toBeNull();
    act(() => view.clearError());
    expect(view.error).toBeNull();
  });
});
