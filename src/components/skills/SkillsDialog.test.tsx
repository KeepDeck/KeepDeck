// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeSkillFile,
  sameSkillRef,
  type SkillDraft,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import type { Settings } from "../../domain/settings";
import type { SkillsEditorState } from "../../app/useSkills";
import { SkillsDialog } from "./SkillsDialog";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ANNOTATED, like the sibling double in useSkills.test.ts: an added field on
// `SkillsEditorState` must fail to compile HERE rather than reach the component
// as `undefined` in every case in this file. Hoisted because a `vi.mock`
// factory's double has to exist before imports are initialized, and handed over
// WHOLE so the field list is written once.
/** A row as the library would hold it after the write landed. */
const landed = (scope: SkillScope, draft: SkillDraft): LibrarySkill => ({
  scope,
  name: draft.name,
  content: composeSkillFile(draft),
});

const lib = vi.hoisted(
  () =>
    ({
      skills: [] as LibrarySkill[] | null,
      error: null as string | null,
      // Widened so a case can flip it: the literal would narrow to `true`.
      listTrusted: true as boolean,
      clearError: vi.fn(),
      // The writes LAND IN THE LIST, the way the real hook's re-read makes them:
      // it awaits a refresh before it resolves, so by the time the dialog sees
      // `true` the row is there. A double that resolved true and left the list
      // alone was a state production cannot produce, and the dialog — which now
      // notices a selection that is missing from the library — read it as the
      // skill having been deleted under it.
      save: vi.fn(async (scope: SkillScope, draft: SkillDraft, mode: "create" | "update") => {
        lib.skills =
          mode === "create"
            ? [...(lib.skills ?? []), landed(scope, draft)]
            : (lib.skills ?? []).map((s) =>
                sameSkillRef(s, { scope, name: draft.name }) ? landed(scope, draft) : s,
              );
        return true;
      }),
      rename: vi.fn(async (scope: SkillScope, from: string, to: string) => {
        lib.skills = (lib.skills ?? []).map((s) =>
          sameSkillRef(s, { scope, name: from }) ? { ...s, name: to } : s,
        );
        return true;
      }),
      remove: vi.fn(async (scope: SkillScope, name: string) => {
        lib.skills = (lib.skills ?? []).filter((s) => !sameSkillRef(s, { scope, name }));
        return true;
      }),
    }) satisfies SkillsEditorState,
);
vi.mock("../../app/useSkills", () => ({ useSkillsLibrary: () => lib }));

// The settings singleton the SkillViewer's unlock hint reads (the hint
// keys on the artifacts SETTING, by the design's divergence ruling).
const settingsState = vi.hoisted(() => ({ current: null as Settings | null }));
vi.mock("../../app/useSettings", () => ({
  useSettings: () => settingsState.current,
}));

const skill = (
  name: string,
  scope: "global" | "workspace" = "global",
  wsId = "",
): LibrarySkill => ({
  scope: scope === "global" ? { kind: "global" } : { kind: "workspace", wsId },
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
    lib.listTrusted = true;
    // `mockClear` only — NOT `mockResolvedValue`, which would replace the
    // implementations above with ones that leave the list untouched, i.e. put the
    // double back in a state the real hook cannot be in. A case that wants a
    // failure says so with `mockResolvedValueOnce`.
    settingsState.current = null;
    lib.clearError.mockClear();
    lib.save.mockClear();
    lib.rename.mockClear();
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

  it("lets a hand-made name this build would refuse be edited and saved", async () => {
    // The library deliberately does not apply the naming rule to an update: the
    // Rust side stores and lists `My_Skill` happily, and a skill copied in by
    // hand must stay editable. Judging the name here too made exactly that skill
    // openable and unsavable, complaining about kebab-case under a name the user
    // was not editing — one rule, two doors, opposite answers. The rule still
    // applies to a name being AUTHORED, which the next case covers.
    lib.skills = [skill("My_Skill")];
    await mount();
    act(() => row("My_Skill")!.click());
    type(textarea(), "edited body");

    expect(document.body.textContent).not.toContain("Lowercase letters");
    expect(button("Save")!.disabled).toBe(false);
    await act(async () => button("Save")!.click());
    expect(lib.save).toHaveBeenCalled();
    expect(lib.rename).not.toHaveBeenCalled();
  });

  it("still refuses a name the user is authoring, and says the whole rule", async () => {
    lib.skills = [skill("My_Skill")];
    await mount();
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
    await mount();
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
    await mount({ id: "ws-1", name: "My project" });

    act(() => row("mine")!.click());
    expect(document.querySelector(".skills__scope")!.textContent).toBe("My project");

    act(() => row("shared")!.click());
    expect(document.querySelector(".skills__scope")!.textContent).toBe("Global");
  });

  it("keeps the editor's own DOM across a save that re-anchors the selection", async () => {
    // The editor must not be remounted per selection: performSubmit changes the
    // selection mid-submit (create→edit, and again on a rename), and a remount
    // there tears down the field the user is typing into, dropping focus and
    // caret with no autoFocus to catch them.
    lib.skills = [];
    await mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    const beforeSave = textarea();

    await act(async () => button("Create")!.click());

    expect(textarea()).toBe(beforeSave);
  });

  it("focuses the name field when the create form appears, not only on mount", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());

    act(() => buttonByTitle("New global skill")!.click());

    expect(document.activeElement).toBe(input("skill-name"));
  });

  it("blocks Delete while a save is in flight, visibly", async () => {
    // Otherwise the two writes race and, if the delete's IPC lands first, the
    // save re-creates the skill the user just confirmed deleting.
    lib.skills = [skill("review")];
    let finishSave!: (ok: boolean) => void;
    lib.save.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishSave = resolve)),
    );
    await mount();
    act(() => row("review")!.click());
    type(textarea(), "edited");

    act(() => button("Save")!.click());

    expect(button("Delete")!.disabled).toBe(true);
    await act(async () => finishSave(true));
    expect(button("Delete")!.disabled).toBe(false);
  });

  it("does not raise a discard confirm for a click on the skill already open", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());
    type(textarea(), "edited");

    act(() => row("review")!.click());

    // That click asked for nothing; the confirm's Discard would have thrown the
    // edits away, and the row is the highlighted one so a stray click is easy.
    expect(document.body.textContent).not.toContain("unsaved changes");
    expect(textarea().value).toBe("edited");
  });

  it("freezes the nav while a delete is in flight, so it cannot strand the editor", async () => {
    // Navigating mid-delete bumps the epoch the delete's own completion checks, so
    // its `apply(null)` was skipped and the editor was left titled with a skill the
    // reload then removed — a live Delete button and no row to correct it with.
    // A SAVE deliberately does NOT freeze the nav: moving on during one is exactly
    // what `navEpoch` makes safe, and the next case pins that.
    lib.skills = [skill("review"), skill("deploy")];
    let finishRemove!: (ok: boolean) => void;
    lib.remove.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishRemove = resolve)),
    );
    await mount();

    act(() => row("review")!.click());
    act(() => button("Delete")!.click());
    // The confirm's own Delete, not the editor's — both carry that label.
    const confirmDelete = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".confirm button, [role=dialog] button"),
    ).find((b) => b.textContent === "Delete" && b !== button("Delete"))!;
    act(() => confirmDelete.click()); // the IPC is now in flight

    expect(row("deploy")!.disabled).toBe(true);
    expect(buttonByTitle("New global skill")!.disabled).toBe(true);

    await act(async () => finishRemove(true));

    // And once it lands the nav is live again. (Dropping the deleted row is the
    // hook's job and pinned in its own suite; this stub resolves without touching
    // the list, which is why `review` is still here.)
    expect(row("deploy")!.disabled).toBe(false);
  });

  it("a rename whose save the user navigated away from still WRITES the content", async () => {
    // The staleness rule governs the REPORT, not the operation. Collapsing the two
    // made a stale rename return early: the directory moved, the content half of the
    // same action was dropped, and since a rename deliberately does not re-read, the
    // nav kept the old row with nothing to correct it.
    lib.skills = [skill("review"), skill("other")];
    let finishRename!: (ok: boolean) => void;
    lib.rename.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishRename = resolve)),
    );
    await mount();
    act(() => row("review")!.click());
    type(input("skill-name"), "deep-review");
    type(input("skill-description"), "the edit that must still land");

    act(() => button("Save")!.click());
    // Navigating mid-save is allowed — that is what navEpoch is for.
    act(() => row("other")!.click());
    await act(async () => finishRename(true));

    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      expect.objectContaining({ description: "the edit that must still land" }),
      "update",
    );
  });

  it("says why Save is dead on a create form when the name is still empty", async () => {
    // The message waits until the user has STARTED, not until they touch the name:
    // filling the description first is the natural order, and holding the message for
    // the field itself left Create disabled with nothing at all on screen.
    await mount();
    act(() => buttonByTitle("New global skill")!.click());
    expect(document.querySelectorAll(".form__error")).toHaveLength(0);

    type(input("skill-description"), "Ships it");

    expect(button("Create")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("A skill needs a name");
  });

  it("refuses to save a skill deleted elsewhere, and drops a clean editor", async () => {
    lib.skills = [skill("review"), skill("other")];
    await mount();
    act(() => row("review")!.click());
    type(textarea(), "unsaved work");

    // The other door removed it; the subscription's refresh is what the real hook
    // would do, and here the double's list is the same state.
    await act(async () => {
      lib.skills = [skill("other")];
      root.render(
        createElement(SkillsDialog, { activeWs: { id: "ws-1", name: "My project" }, onClose: () => closed++ }),
      );
    });

    expect(document.body.textContent).toContain("removed or renamed elsewhere");
    expect(textarea().value).toBe("unsaved work");
    expect(button("Save")!.disabled).toBe(true);
  });

  it("does not judge a skill gone from a list whose last read failed", async () => {
    lib.skills = [skill("other")];
    lib.listTrusted = false;
    await mount();
    // A selection the list does not hold, over an untrustworthy list: absence proves
    // nothing, so no refusal and no message.
    act(() => row("other")!.click());

    expect(document.body.textContent).not.toContain("removed or renamed elsewhere");
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
      // Not a create: the rename above already moved the directory, so what
      // lands is an overwrite of a skill that exists.
      "update",
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
      "update",
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

  it("Escape closes the dialog, but belongs to a confirm stacked over it", async () => {
    lib.skills = [skill("review")];
    await mount();

    act(() => row("review")!.click());
    act(() => button("Delete")!.click());
    expect(document.querySelector(".confirm")).not.toBeNull();

    const covered = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(covered);
    });
    // The confirm's own handler dismisses it; this dialog must not have
    // claimed the same press, or one Escape would close both.
    expect(document.querySelector(".skills")).not.toBeNull();

    const own = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(async () => {
      window.dispatchEvent(own);
    });
    expect(closed).toBe(1);
    expect(own.defaultPrevented).toBe(true);
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

  it("a multi-line paste into the description folds to one line and saves so", async () => {
    lib.skills = [skill("review")];
    await mount();
    act(() => row("review")!.click());

    type(input("skill-description"), "reviews diffs\r\n  with subagents\n\nread-only");
    expect(input("skill-description").value).toBe(
      "reviews diffs with subagents read-only",
    );

    await act(async () => button("Save")!.click());
    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      expect.objectContaining({ description: "reviews diffs with subagents read-only" }),
      "update",
    );
  });

  // The layout half of ⌘S — that the S key reporting "ы" still saves — belongs to
  // `useSaveShortcut` and is pinned in its own suite now. It was a near-copy of the
  // case above differing only in `key`, and since the hook matches on `e.code`
  // alone neither could fail without the other.

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

  it("keystrokes typed DURING a save stay dirty — never silently dropped", async () => {
    lib.skills = [skill("review")];
    let releaseSave!: (ok: boolean) => void;
    lib.save.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseSave = resolve)),
    );
    await mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "first edit");
    await act(async () => button("Save")!.click());

    // The save is in flight; the user keeps typing.
    type(input("skill-description"), "first edit plus more");
    await act(async () => releaseSave(true));

    // The newer text is on screen, NOT on disk — Save must stay available.
    expect(input("skill-description").value).toBe("first edit plus more");
    expect(button("Save")!.disabled).toBe(false);
    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      expect.objectContaining({ description: "first edit" }),
      "update",
    );
  });

  it("a submit completing after navigation does not yank the user back", async () => {
    lib.skills = [skill("review"), skill("deploy")];
    let releaseSave!: (ok: boolean) => void;
    lib.save.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseSave = resolve)),
    );
    await mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");
    await act(async () => button("Save")!.click());

    // While the save is pending, the user moves to another skill (the form
    // is still dirty → discard confirm → Discard).
    act(() => row("deploy")!.click());
    act(() => button("Discard")!.click());
    expect(
      document.querySelector(".skills__editor-title")!.textContent,
    ).toContain("deploy");

    await act(async () => releaseSave(true));
    // The completed submit must NOT pull the selection back to "review".
    expect(
      document.querySelector(".skills__editor-title")!.textContent,
    ).toContain("deploy");
    expect(input("skill-description").value).toBe("About deploy");
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
    await mount();

    expect(document.body.textContent).toContain("Could not read");

    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "review");
    type(input("skill-description"), "Reviews diffs");
    type(textarea(), "Steps");

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
  // Reusing the parent describe's harness (root/mount/row helpers are in
// scope via the closure — declared at module level).
it("renders the Bundled group LAST with both same-name rows visible (namespaces at rest)", async () => {
  lib.skills = [
    skill("artifacts"),
    { scope: { kind: "bundled" }, name: "artifacts", content: skill("artifacts").content },
  ];
  await mount();
  const labels = Array.from(
    document.querySelectorAll(".skills__group-label"),
  ).map((el) => el.textContent);
  expect(labels).toEqual(["Global", "My project", "Bundled"]);
  // The UNION: both rows present — the user's and the shipped one.
  expect(document.querySelectorAll(".skills__item")).toHaveLength(2);
});

it("a bundled row opens the read-only viewer — no Save, no Delete, never dirty", async () => {
  lib.skills = [
    { scope: { kind: "bundled" }, name: "artifacts", content: skill("artifacts").content },
  ];
  await mount();
  await act(async () => {
    row("artifacts")!.click();
  });
  // The viewer (selectable copy text + the ships-with note), not the form.
  expect(document.querySelector(".skill-viewer")).not.toBeNull();
  expect(
    document.querySelector(".skill-viewer__note")?.textContent,
  ).toContain("copy any part");
  // The write machine is absent — no body textarea, no Save button.
  expect(document.querySelector("#skill-body")).toBeNull();
  expect(button("Save")).toBeUndefined();
});

it("the viewer shows the bundled row's CONTENT, not a blank shell (RL-8)", async () => {
  // The nav-click path once fell through apply() with no view branch:
  // setForm(EMPTY_FORM) — a blank name/description/body while every
  // presence pin stayed green. A viewer pin asserts the DATA.
  lib.skills = [
    {
      scope: { kind: "bundled" },
      name: "artifacts",
      content:
        "---\nname: artifacts\ndescription: Publish live pages from any pane\n---\n\nPublish body text.",
    },
  ];
  await mount();
  await act(async () => {
    row("artifacts")!.click();
  });
  expect(
    document.querySelector(".skill-viewer__name")?.textContent,
  ).toBe("artifacts");
  expect(
    document.querySelector(".skill-viewer__description")?.textContent,
  ).toBe("Publish live pages from any pane");
  expect(
    document.querySelector(".skill-viewer__body")?.textContent,
  ).toContain("Publish body text.");
});

it("opening the BUNDLED row in the union highlights exactly one row", async () => {
    // The day-one union: a user-global artifacts AND the bundled one.
    // View-mode matching is scope-checked — a name-only match would
    // highlight both rows at once.
    lib.skills = [
      skill("artifacts"),
      { scope: { kind: "bundled" }, name: "artifacts", content: skill("artifacts").content },
    ];
    await mount();
    // Open the BUNDLED row (the last one carrying the name).
    const rows = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".skills__item"),
    );
    const bundledRow = rows.reverse().find(
      (b) => b.querySelector(".skills__item-name")?.textContent === "artifacts",
    )!;
    await act(async () => {
      bundledRow.click();
    });
    expect(document.querySelector(".skill-viewer")).not.toBeNull();
    const active = document.querySelectorAll(".skills__item--active");
    expect(active).toHaveLength(1);
  });

it("the unlock hint shows while the artifacts setting is off, absent while on", async () => {
    // The both-ways pin §J named: the hint keys on the SETTING (not the
    // claim — the design's owned divergence), and unknown (null) hides it.
    lib.skills = [
      { scope: { kind: "bundled" }, name: "artifacts", content: skill("artifacts").content },
    ];
    await mount();
    await act(async () => {
      row("artifacts")!.click();
    });

    // Setting OFF (a re-render with a changed snapshot flips the hint).
    settingsState.current = { artifacts: false } as Settings;
    await act(async () => {
      root.render(
        createElement(SkillsDialog, { activeWs: { id: "ws-1", name: "My project" }, onClose: () => closed++ }),
      );
    });
    const hint = document.querySelector(".skill-viewer__hint");
    expect(hint?.textContent).toContain("artifacts experiment");

    // Setting ON: absent.
    settingsState.current = { artifacts: true } as Settings;
    await act(async () => {
      root.render(
        createElement(SkillsDialog, { activeWs: { id: "ws-1", name: "My project" }, onClose: () => closed++ }),
      );
    });
    expect(document.querySelector(".skill-viewer__hint")).toBeNull();

    // Boot-unknown (null): no hint on unknown.
    settingsState.current = null;
    await act(async () => {
      root.render(
        createElement(SkillsDialog, { activeWs: { id: "ws-1", name: "My project" }, onClose: () => closed++ }),
      );
    });
    expect(document.querySelector(".skill-viewer__hint")).toBeNull();
  });

  it("the bundled group carries no + New button (the teaching is the affordance)", async () => {
  lib.skills = [
    { scope: { kind: "bundled" }, name: "artifacts", content: skill("artifacts").content },
  ];
  await mount();
  // Global keeps its create affordance; Bundled does not.
  expect(buttonByTitle("New global skill")).toBeDefined();
  expect(buttonByTitle("New bundled skill")).toBeNull();
});
});