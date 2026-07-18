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
  save: vi.fn(async () => true),
  remove: vi.fn(async () => true),
}));
vi.mock("../../app/useSkills", () => ({
  useSkillsLibrary: () => ({
    skills: lib.skills,
    error: lib.error,
    save: lib.save,
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
    lib.save.mockClear();
    lib.save.mockResolvedValue(true);
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

  it("groups the library: global plus the ACTIVE workspace only", async () => {
    lib.skills = [
      skill("review"),
      skill("mine", "workspace", "ws-1"),
      skill("foreign", "workspace", "ws-9"),
    ];
    await mount();

    expect(button("review")).toBeDefined();
    expect(button("mine")).toBeDefined();
    // Another workspace's skill is not this dialog's business.
    expect(button("foreign")).toBeUndefined();
    // The workspace group is titled by the workspace's own name.
    expect(document.body.textContent).toContain("My project");
  });

  it("without a workspace there is no workspace group at all", async () => {
    await mount(null);
    expect(buttonByTitle("New workspace skill")).toBeNull();
    expect(buttonByTitle("New global skill")).not.toBeNull();
  });

  it("selecting a skill fills the editor; the name is immutable", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => button("review")!.click());

    expect(input("skill-name").value).toBe("review");
    expect(input("skill-name").disabled).toBe(true);
    expect(input("skill-description").value).toBe("About review");
    expect(textarea().value).toBe("Body of review\n");
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
    act(() => button("review")!.click());
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
    act(() => button("review")!.click());
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
