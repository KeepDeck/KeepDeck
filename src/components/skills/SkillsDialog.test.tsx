// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSkill } from "../../ipc/skills";
import { SkillsDialog } from "./SkillsDialog";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const lib = vi.hoisted(() => ({
  skills: [] as StoredSkill[] | null,
  error: null as string | null,
  clearError: vi.fn(),
  save: vi.fn(async () => true),
  rename: vi.fn(async () => true),
  remove: vi.fn(async () => true),
}));
vi.mock("../../app/useSkills", () => ({
  useSkillsLibrary: () => ({
    skills: lib.skills,
    error: lib.error,
    clearError: lib.clearError,
    save: lib.save,
    rename: lib.rename,
    remove: lib.remove,
  }),
}));

const skill = (
  name: string,
  scope: "global" | "workspace" = "global",
  wsId: string | null = null,
): StoredSkill => ({
  scope,
  wsId,
  name,
  content: `---\nname: ${name}\ndescription: About ${name}\n---\nBody of ${name}\n`,
});

const row = (name: string) =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(".skills__item"),
  ).find((b) => b.querySelector(".skills__item-name")?.textContent === name);
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );
const buttonByTitle = (title: string) =>
  document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
const input = (id: string) =>
  document.querySelector<HTMLInputElement>(`#${id}`)!;
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>("#skill-body")!;

/** Type into a controlled React field: native setter + bubbling `input`. */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SkillsDialog", () => {
  let root: Root;
  let closed: number;

  beforeEach(() => {
    lib.skills = [];
    lib.error = null;
    lib.clearError.mockClear();
    lib.save.mockClear();
    lib.save.mockResolvedValue(true);
    lib.rename.mockClear();
    lib.rename.mockResolvedValue(true);
    lib.remove.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    closed = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = (activeWs: { id: string; name: string } | null = { id: "ws-1", name: "My project" }) =>
    act(async () =>
      root.render(
        createElement(SkillsDialog, { activeWs, onClose: () => closed++ }),
      ),
    );

  it("shows the loading placeholder until the first library read lands", async () => {
    lib.skills = null;
    await mount();
    expect(document.body.textContent).toContain("Loading…");
    expect(document.body.textContent).not.toContain("One skill, every agent");
  });

  it("discarding edits can land on the CREATE form, not only on close", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");

    act(() => buttonByTitle("New global skill")!.click());
    expect(document.body.textContent).toContain("unsaved changes");
    act(() => button("Discard")!.click());

    // The create form opens CLEAN — nothing bleeds over from the discard.
    expect(document.body.textContent).toContain("New skill");
    expect(input("skill-name").value).toBe("");
    expect(input("skill-description").value).toBe("");
    expect(closed).toBe(0);
  });

  it("groups the library: global plus the ACTIVE workspace only", async () => {
    lib.skills = [
      skill("review"),
      skill("mine", "workspace", "ws-1"),
      skill("foreign", "workspace", "ws-9"),
    ];
    await mount();

    expect(row("review")).toBeDefined();
    expect(row("mine")).toBeDefined();
    // Another workspace's skill is not this dialog's business.
    expect(row("foreign")).toBeUndefined();
    // The workspace group is titled by the workspace's own name.
    expect(document.body.textContent).toContain("My project");
  });

  it("without a workspace there is no workspace group at all", async () => {
    await mount(null);
    expect(buttonByTitle("New workspace skill")).toBeNull();
    expect(buttonByTitle("New global skill")).not.toBeNull();
  });

  it("selecting a skill fills the editor, name included", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());

    expect(
      document.querySelector(".skills__editor-title")!.textContent,
    ).toContain("review");
    expect(input("skill-name").value).toBe("review");
    expect(input("skill-name").disabled).toBe(false);
    expect(input("skill-description").value).toBe("About review");
    expect(textarea().value).toBe("Body of review\n");
  });

  it("editing the name renames first, then saves under the new name", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());
    type(input("skill-name"), "deep-review");
    await act(async () => button("Save")!.click());

    expect(lib.rename).toHaveBeenCalledWith({ kind: "global" }, "review", "deep-review");
    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      expect.objectContaining({ name: "deep-review" }),
    );
  });

  it("a failed save after a successful rename is retryable, not a dead end", async () => {
    lib.skills = [skill("review")];
    lib.save.mockResolvedValueOnce(false); // disk said no, once
    await mount();
    act(() => row("review")!.click());
    type(input("skill-name"), "deep-review");
    await act(async () => button("Save")!.click());

    // The directory moved; the editor must follow the new name — its own
    // name is not a collision, so Save stays available for a retry.
    expect(document.body.textContent).not.toContain("already exists");
    expect(button("Save")!.disabled).toBe(false);

    await act(async () => button("Save")!.click());
    // The retry is a plain save under the new name — no second rename.
    expect(lib.rename).toHaveBeenCalledTimes(1);
    expect(lib.save).toHaveBeenLastCalledWith(
      { kind: "global" },
      expect.objectContaining({ name: "deep-review" }),
    );
  });

  it("⌘S yields while a confirm is up — saving under it would defeat it", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");
    act(() => button("Delete")!.click());
    expect(document.querySelector(".confirm")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true }),
      );
    });
    expect(lib.save).not.toHaveBeenCalled();
    expect(lib.rename).not.toHaveBeenCalled();
  });

  it("a stale operation error clears when navigating to another skill", async () => {
    lib.skills = [skill("review"), skill("deploy")];
    lib.error = "Save failed: disk full";
    await mount();
    act(() => row("review")!.click());
    expect(document.body.textContent).toContain("disk full");

    act(() => row("deploy")!.click());
    expect(lib.clearError).toHaveBeenCalled();
  });

  it("a vanished discard target falls back to the placeholder, not a ghost editor", async () => {
    lib.skills = [skill("review"), skill("deploy")];
    await mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");
    act(() => row("deploy")!.click()); // discard confirm captures the target

    lib.skills = [skill("review")]; // "deploy" vanishes meanwhile
    await mount();
    act(() => button("Discard")!.click());

    expect(document.querySelector(".skills__editor-title")).toBeNull();
    expect(document.body.textContent).toContain("One skill, every agent");
  });

  it("renaming onto another skill in the scope is blocked; keeping your own name is not", async () => {
    lib.skills = [skill("review"), skill("deploy")];
    await mount();
    act(() => row("review")!.click());

    type(input("skill-name"), "deploy");
    expect(button("Save")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("already exists");

    type(input("skill-name"), "review");
    type(input("skill-description"), "Edited description");
    expect(button("Save")!.disabled).toBe(false);
    await act(async () => button("Save")!.click());
    // Same name — an ordinary save, no rename call.
    expect(lib.rename).not.toHaveBeenCalled();
  });

  it("the library rows preview each skill's description", async () => {
    lib.skills = [skill("review")];
    await mount();
    expect(
      document.querySelector(".skills__item-desc")!.textContent,
    ).toBe("About review");
  });

  it("⌘S fires by PHYSICAL key — a Cyrillic layout saves too", async () => {
    await mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    type(textarea(), "Steps");

    await act(async () => {
      // ЙЦУКЕН: the S key reports key "ы"; only e.code identifies it.
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ы", code: "KeyS", metaKey: true }),
      );
    });
    expect(lib.save).toHaveBeenCalledTimes(1);
  });

  it("a double ⌘S submits once — rename is not idempotent", async () => {
    lib.skills = [skill("review")];
    // Keep the first submit in flight until both keydowns landed.
    let release!: (ok: boolean) => void;
    lib.rename.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    await mount();
    act(() => row("review")!.click());
    type(input("skill-name"), "deep-review");

    const chord = () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true }),
      );
    await act(async () => {
      chord();
      chord();
    });
    await act(async () => {
      release(true);
    });

    expect(lib.rename).toHaveBeenCalledTimes(1);
  });

  it("⌘S saves when the draft is valid", async () => {
    await mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    type(textarea(), "Steps");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true }),
      );
    });
    expect(lib.save).toHaveBeenCalledTimes(1);
  });

  it("creates a skill in the scope whose + New was clicked", async () => {
    await mount();
    act(() => buttonByTitle("New workspace skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    type(textarea(), "Steps");
    await act(async () => button("Create")!.click());

    expect(lib.save).toHaveBeenCalledWith(
      { kind: "workspace", wsId: "ws-1" },
      {
        name: "deploy",
        description: "Ships it",
        body: "Steps",
        extraFrontmatter: [],
      },
    );
  });

  it("refuses to save without a description — some CLIs silently drop such skills", async () => {
    await mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(textarea(), "Steps");

    expect(button("Create")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("Required");

    type(input("skill-description"), "Ships it");
    expect(button("Create")!.disabled).toBe(false);
  });

  it("blocks creating with an invalid or colliding name", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-description"), "A valid description");

    type(input("skill-name"), "Bad Name");
    expect(button("Create")!.disabled).toBe(true);

    type(input("skill-name"), "review");
    expect(button("Create")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("already exists");

    type(input("skill-name"), "fresh-name");
    expect(button("Create")!.disabled).toBe(false);
  });

  it("deleting asks first and routes through the library", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());
    act(() => button("Delete")!.click());

    // In-app confirm, not a system dialog.
    expect(document.body.textContent).toContain('Delete "review"?');
    const confirmDelete = Array.from(
      document.querySelector(".confirm")!.querySelectorAll("button"),
    ).find((b) => b.textContent === "Delete")!;
    await act(async () => confirmDelete.click());
    expect(lib.remove).toHaveBeenCalledWith({ kind: "global" }, "review");
  });

  it("guards unsaved edits behind a discard confirm on close", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");

    act(() => buttonByTitle("Close skills")!.click());
    expect(closed).toBe(0);
    expect(document.body.textContent).toContain("unsaved changes");

    act(() => button("Keep editing")!.click());
    expect(closed).toBe(0);

    act(() => buttonByTitle("Close skills")!.click());
    act(() => button("Discard")!.click());
    expect(closed).toBe(1);
  });
});
