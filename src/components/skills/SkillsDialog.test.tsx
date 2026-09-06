// @vitest-environment happy-dom
// The dialog's own markup: the placeholder, the nav's groups and copy, the
// create form, and the fields' verdicts as words. What the machine does
// underneath is pinned once, in ../library/useLibraryEditor.test.tsx.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lib, skill, skillsDialogHost } from "./skillsDialogTestSupport";
import { row, button, buttonByTitle, input, textarea, type } from "../library/libraryTestDom";
import { SkillsDialog } from "./SkillsDialog";

describe("SkillsDialog", () => {
  const host = skillsDialogHost(SkillsDialog);
  beforeEach(() => host.setup());
  afterEach(() => host.teardown());

  it("shows the loading placeholder until the first library read lands", async () => {
    lib.skills = null;
    await host.mount();
    expect(document.body.textContent).toContain("Loading…");
    expect(document.body.textContent).not.toContain("One skill, every agent");
  });

  it("lets a hand-made name this build would refuse be edited and saved", async () => {
    // The library deliberately does not apply the naming rule to an update: the
    // Rust side stores and lists `My_Skill` happily, and a skill copied in by
    // hand must stay editable. Judging the name here too made exactly that skill
    // openable and unsavable, complaining about kebab-case under a name the user
    // was not editing — one rule, two doors, opposite answers. The rule still
    // applies to a name being AUTHORED, which the next case covers.
    lib.skills = [skill("My_Skill")];
    await host.mount();
    act(() => row("My_Skill")!.click());
    type(textarea("skill-body"), "edited body");

    expect(document.body.textContent).not.toContain("Lowercase letters");
    expect(button("Save")!.disabled).toBe(false);
    await act(async () => button("Save")!.click());
    expect(lib.save).toHaveBeenCalled();
    expect(lib.rename).not.toHaveBeenCalled();
  });

  it("still refuses a name the user is authoring, and says the whole rule", async () => {
    lib.skills = [skill("My_Skill")];
    await host.mount();
    act(() => row("My_Skill")!.click());
    // Touching the name makes it this editor's to judge again.
    type(input("skill-name"), "My_Skill_2");

    expect(button("Save")!.disabled).toBe(true);
    // The full rule, from the domain — three surfaces used to describe it from
    // memory and all three described a subset, so `my-skill-` was told it may
    // contain "lowercase letters, digits and hyphens only" and refused anyway.
    expect(document.body.textContent).toContain("not starting or ending with a hyphen");
  });

  it("says why Save is dead when the name is EMPTY, not just that it is", async () => {
    // With a boolean predicate the gate counted "" as invalid and the message
    // counted it as "nothing typed yet", so clearing the field disabled Save
    // with nothing on screen.
    lib.skills = [skill("review")];
    await host.mount();
    act(() => row("review")!.click());
    type(input("skill-name"), "");

    expect(button("Save")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("A skill needs a name");
  });

  it("names the scope from its GROUP, not from whichever workspace is active", async () => {
    // The chip is the only thing on screen saying which library a save lands in,
    // and it used to answer a different question — "what is the active workspace
    // called" — so it stamped that name over any other scope's skill.
    lib.skills = [skill("mine", "workspace", "ws-1"), skill("shared")];
    await host.mount({ id: "ws-1", name: "My project" });

    act(() => row("mine")!.click());
    expect(document.querySelector(".library__scope")!.textContent).toBe("My project");

    act(() => row("shared")!.click());
    expect(document.querySelector(".library__scope")!.textContent).toBe("Global");
  });

  it("focuses the name field when the create form appears, not only on mount", async () => {
    lib.skills = [skill("review")];
    await host.mount();
    act(() => row("review")!.click());

    act(() => buttonByTitle("New global skill")!.click());

    expect(document.activeElement).toBe(input("skill-name"));
  });

  it("says why Save is dead on a create form when the name is still empty", async () => {
    // The message waits until the user has STARTED, not until they touch the name:
    // filling the description first is the natural order, and holding the message for
    // the field itself left Create disabled with nothing at all on screen.
    await host.mount();
    act(() => buttonByTitle("New global skill")!.click());
    expect(document.querySelectorAll(".form__error")).toHaveLength(0);

    type(input("skill-description"), "Ships it");

    expect(button("Create")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("A skill needs a name");
  });

  it("groups the library: global plus the ACTIVE workspace only", async () => {
    lib.skills = [
      skill("review"),
      skill("mine", "workspace", "ws-1"),
      skill("foreign", "workspace", "ws-9"),
    ];
    await host.mount();

    expect(row("review")).toBeDefined();
    expect(row("mine")).toBeDefined();
    // Another workspace's skill is not this dialog's business.
    expect(row("foreign")).toBeUndefined();
    // The workspace group is titled by the workspace's own name.
    expect(document.body.textContent).toContain("My project");
  });

  it("without a workspace there is no workspace group at all", async () => {
    await host.mount(null);
    expect(buttonByTitle("New workspace skill")).toBeNull();
    expect(buttonByTitle("New global skill")).not.toBeNull();
  });

  it("selecting a skill fills the editor, name included", async () => {
    lib.skills = [skill("review")];
    await host.mount();
    act(() => row("review")!.click());

    expect(
      document.querySelector(".library__editor-title")!.textContent,
    ).toContain("review");
    expect(input("skill-name").value).toBe("review");
    expect(input("skill-name").disabled).toBe(false);
    expect(input("skill-description").value).toBe("About review");
    expect(textarea("skill-body").value).toBe("Body of review\n");
  });

  it("the library rows preview each skill's description", async () => {
    lib.skills = [skill("review")];
    await host.mount();
    expect(
      document.querySelector(".library__item-desc")!.textContent,
    ).toBe("About review");
  });

  it("⌘S saves when the draft is valid", async () => {
    await host.mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    type(textarea("skill-body"), "Steps");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true }),
      );
    });
    expect(lib.save).toHaveBeenCalledTimes(1);
  });

  it("creates a skill in the scope whose + New was clicked", async () => {
    await host.mount();
    act(() => buttonByTitle("New workspace skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    type(textarea("skill-body"), "Steps");
    await act(async () => button("Create")!.click());

    expect(lib.save).toHaveBeenCalledWith(
      { kind: "workspace", wsId: "ws-1" },
      {
        name: "deploy",
        description: "Ships it",
        body: "Steps",
        extraFrontmatter: [],
      },
      // A create says so, so the backend refuses a name already on disk even
      // if the dialog's own collision check was working from a library it
      // could not read.
      "create",
    );
  });

  it("still offers Create when the library could not be read, and says so", async () => {
    // A failed read arrives as an empty list plus an error. Disabling Create
    // here would leave a dead button on a dialog that shows no rows to open
    // either — nothing left to do and nothing saying why. The backend refuses
    // a real collision, so the offer is safe to keep.
    lib.skills = [];
    lib.error = "Could not read the skills library: boom";
    await host.mount();

    expect(document.body.textContent).toContain("Could not read");

    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "review");
    type(input("skill-description"), "Reviews diffs");
    type(textarea("skill-body"), "Steps");

    expect(button("Create")!.disabled).toBe(false);
    await act(async () => button("Create")!.click());
    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      expect.objectContaining({ name: "review" }),
      // Marked a create, so the backend can refuse the name this empty list
      // could not tell us was taken.
      "create",
    );
  });

  it("refuses to save without a description — some CLIs silently drop such skills", async () => {
    await host.mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(textarea("skill-body"), "Steps");

    expect(button("Create")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("Required");

    type(input("skill-description"), "Ships it");
    expect(button("Create")!.disabled).toBe(false);
  });

  it("blocks creating with an invalid or colliding name", async () => {
    lib.skills = [skill("review")];
    await host.mount();
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
});
