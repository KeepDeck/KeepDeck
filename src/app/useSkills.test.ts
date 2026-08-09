// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillsLibrary, type SkillsEditorState } from "./useSkills";
import type { LibrarySkill, SkillsLibrary } from "./skillsLibrary";

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
// ANNOTATED, and hoisted rather than taken from the shared factory: a
// `vi.mock` factory's double has to exist before imports are initialized. The
// annotation is what makes the compiler guard this copy — without it the fake
// silently omitted `read`, and a hook change reaching for it would have failed
// only at runtime, in whichever case happened to touch that path.
const library = vi.hoisted(
  () =>
    ({
      list: vi.fn<() => Promise<LibrarySkill[]>>(async () => []),
      // Inline rather than the DRAFT const below: a hoisted factory runs before
      // this module's own bindings exist.
      read: vi.fn(async () => ({
        name: "review",
        description: "Reads it",
        body: "",
        extraFrontmatter: [],
      })),
      create: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      // Kept as a real registry, not a no-op: the hook subscribes so a write
      // through the OTHER door refreshes the list, and a stub that never calls
      // back would leave that untested.
      subscribe: vi.fn((listener: () => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      }),
    }) satisfies SkillsLibrary,
);
const subscribers = vi.hoisted(() => new Set<() => void>());
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ skills: library }),
}));

const STORED: LibrarySkill = {
  scope: { kind: "global" },
  name: "review",
  content: "x",
};
const DRAFT = { name: "deploy", description: "Ships it", body: "", extraFrontmatter: [] };

let view: SkillsEditorState;
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

  it("a successful save whose reload fails keeps the stale list, and SAYS it is stale", async () => {
    library.list.mockResolvedValue([STORED]);
    await mount();
    library.list.mockRejectedValueOnce(new Error("transient"));

    let ok = false;
    await act(async () => {
      ok = await view.save({ kind: "global" }, DRAFT, false);
    });

    expect(ok).toBe(true); // the write itself landed
    expect(view.skills).toHaveLength(1); // stale beats blank
    // But not silently. Saying nothing let a delete whose reload failed leave the
    // deleted skill listed with three signals disagreeing, and the notice names
    // the list rather than the write — the write is what just worked.
    expect(view.error).toContain("may be out of date");
    expect(view.listUnknown).toBe(false);
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

  it("re-reads when the library changes through the OTHER door", async () => {
    // An agent's skills.delete does not go through this hook, so without the
    // subscription the nav kept listing a skill that was gone and every save
    // against it failed with nowhere for the typed text to land.
    library.list.mockResolvedValue([STORED]);
    await mount();
    expect(library.list).toHaveBeenCalledTimes(1);

    library.list.mockResolvedValue([]);
    await act(async () => {
      for (const notify of subscribers) notify();
    });

    expect(view.skills).toEqual([]);
  });

  it("a superseded read does not land over a newer one", async () => {
    // Reachable on a slow backend: the dialog's first read is still in flight
    // while a create's re-read lands, and the older answer used to overwrite it —
    // putting the pre-create library back and hiding a skill that exists.
    let finishFirst!: (rows: LibrarySkill[]) => void;
    library.list.mockImplementationOnce(
      () => new Promise<LibrarySkill[]>((resolve) => (finishFirst = resolve)),
    );
    await mount();

    library.list.mockResolvedValue([STORED]);
    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, true);
    });
    expect(view.skills).toEqual([STORED]);

    // The first read finally answers, with the library as it was BEFORE the save.
    await act(async () => finishFirst([]));
    expect(view.skills).toEqual([STORED]);
  });

  it("reports a failed read that supersedes the first one, instead of loading forever", async () => {
    // "keep the stale list" has nothing to keep before the first read lands. A
    // background re-read (an agent's write) that overtakes the dialog's first
    // read and then fails used to leave skills=null AND error=null — the editor
    // sat on "Loading…" with nothing saying why.
    let finishFirst!: (rows: LibrarySkill[]) => void;
    library.list.mockImplementationOnce(
      () => new Promise<LibrarySkill[]>((resolve) => (finishFirst = resolve)),
    );
    await mount();

    library.list.mockRejectedValueOnce(new Error("backend down"));
    await act(async () => {
      for (const notify of subscribers) notify();
    });

    expect(view.error).toContain("backend down");
    expect(view.listUnknown).toBe(true);

    // AND the superseded read must not undo that when it finally lands. Stopping
    // here left the staleness guard untested from this direction: remove it and the
    // older read would quietly overwrite the reported failure with its own rows,
    // and this case would still have passed.
    await act(async () => finishFirst([STORED]));
    expect(view.error).toContain("backend down");
    expect(view.skills).toEqual([]);
  });

  it("a background read clears a READ error but not the save error under it", async () => {
    // Two kinds of notice with two lifetimes: a working read answers "could not
    // read the library"; it does not answer "your save did not land".
    library.list.mockRejectedValueOnce(new Error("backend down"));
    await mount();
    expect(view.error).toContain("Could not read");

    library.list.mockResolvedValue([STORED]);
    await act(async () => {
      for (const notify of subscribers) notify();
    });
    expect(view.error).toBeNull();

    library.update.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, false);
    });
    expect(view.error).toContain("disk full");

    await act(async () => {
      for (const notify of subscribers) notify();
    });
    // Still there: the user has not acted on it yet.
    expect(view.error).toContain("disk full");
  });

  it("does not answer its OWN write's notification with a second read", async () => {
    // Every mutation notifies, this hook is a subscriber, and it also reloads
    // when its own write settles — answering both would double the reads per
    // user action, against the one-action-one-reload rule above.
    library.update.mockImplementationOnce(async () => {
      for (const notify of subscribers) notify();
    });
    await mount();
    expect(library.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      await view.save({ kind: "global" }, DRAFT, false);
    });

    expect(library.list).toHaveBeenCalledTimes(2);
  });

  it("clearError drops the notice when the user navigates away", async () => {
    library.list.mockRejectedValueOnce(new Error("backend down"));
    await mount();
    expect(view.error).not.toBeNull();
    act(() => view.clearError());
    expect(view.error).toBeNull();
  });
});
