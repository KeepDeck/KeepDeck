// @vitest-environment happy-dom
// Editing an existing skill through the dialog: what the fields, the buttons
// and the keyboard do around a save, a rename and a delete.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lib, skill, skillsDialogHost } from "./skillsDialogTestSupport";
import { button, buttonByTitle, confirmButton, input, row, textarea, type } from "../library/libraryTestDom";
import { SkillsDialog } from "./SkillsDialog";

describe("SkillsDialog — editing", () => {
  const host = skillsDialogHost(SkillsDialog);
  beforeEach(() => host.setup());
  afterEach(() => host.teardown());

  it("discarding edits can land on the CREATE form, not only on close", async () => {
    lib.skills = [skill("review")];
    await host.mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");

    act(() => buttonByTitle("New global skill")!.click());
    expect(document.body.textContent).toContain("unsaved changes");
    act(() => button("Discard")!.click());

    // The create form opens CLEAN — nothing bleeds over from the discard.
    expect(document.body.textContent).toContain("New skill");
    expect(input("skill-name").value).toBe("");
    expect(input("skill-description").value).toBe("");
    expect(host.closed()).toBe(0);
  });

  it("keeps the editor's own DOM across a save that re-anchors the selection", async () => {
    // The editor must not be remounted per selection: performSubmit changes the
    // selection mid-submit (create→edit, and again on a rename), and a remount
    // there tears down the field the user is typing into, dropping focus and
    // caret with no autoFocus to catch them.
    lib.skills = [];
    await host.mount();
    act(() => buttonByTitle("New global skill")!.click());
    type(input("skill-name"), "deploy");
    type(input("skill-description"), "Ships it");
    const beforeSave = textarea("skill-body");

    await act(async () => button("Create")!.click());

    expect(textarea("skill-body")).toBe(beforeSave);
  });

  it("blocks Delete while a save is in flight, visibly", async () => {
    // Otherwise the two writes race and, if the delete's IPC lands first, the
    // save re-creates the skill the user just confirmed deleting.
    lib.skills = [skill("review")];
    let finishSave!: (ok: boolean) => void;
    lib.save.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishSave = resolve)),
    );
    await host.mount();
    act(() => row("review")!.click());
    type(textarea("skill-body"), "edited");

    act(() => button("Save")!.click());

    expect(button("Delete")!.disabled).toBe(true);
    await act(async () => finishSave(true));
    expect(button("Delete")!.disabled).toBe(false);
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
    await host.mount();

    act(() => row("review")!.click());
    act(() => button("Delete")!.click());
    // The confirm's own Delete, not the editor's — both carry that label.
    const confirmDelete = confirmButton("Delete")!;
    act(() => confirmDelete.click()); // the IPC is now in flight

    expect(row("deploy")!.disabled).toBe(true);
    expect(buttonByTitle("New global skill")!.disabled).toBe(true);

    await act(async () => finishRemove(true));

    // And once it lands the nav is live again. (Dropping the deleted row is the
    // hook's job and pinned in its own suite; this stub resolves without touching
    // the list, which is why `review` is still here.)
    expect(row("deploy")!.disabled).toBe(false);
  });

  it("refuses to save a skill deleted elsewhere, and drops a clean editor", async () => {
    lib.skills = [skill("review"), skill("other")];
    await host.mount();
    act(() => row("review")!.click());
    type(textarea("skill-body"), "unsaved work");

    // The other door removed it; the subscription's refresh is what the real hook
    // would do, and here the double's list is the same state.
    lib.skills = [skill("other")];
    await host.mount();

    expect(document.body.textContent).toContain("removed or renamed elsewhere");
    expect(textarea("skill-body").value).toBe("unsaved work");
    expect(button("Save")!.disabled).toBe(true);
  });

  it("does not judge a skill gone from a list whose last read failed", async () => {
    lib.skills = [skill("other")];
    lib.listTrusted = false;
    await host.mount();
    // A selection the list does not hold, over an untrustworthy list: absence proves
    // nothing, so no refusal and no message.
    act(() => row("other")!.click());

    expect(document.body.textContent).not.toContain("removed or renamed elsewhere");
  });

  it("editing the name renames first, then saves under the new name", async () => {
    lib.skills = [skill("review")];
    await host.mount();
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

  it("⌘S yields while a confirm is up — saving under it would defeat it", async () => {
    lib.skills = [skill("review")];
    await host.mount();
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
    await host.mount();

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
    expect(document.querySelector(".library")).not.toBeNull();

    const own = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(async () => {
      window.dispatchEvent(own);
    });
    expect(host.closed()).toBe(1);
    expect(own.defaultPrevented).toBe(true);
  });

  it("renaming onto another skill in the scope is blocked; keeping your own name is not", async () => {
    lib.skills = [skill("review"), skill("deploy")];
    await host.mount();
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

  it("a multi-line paste into the description folds to one line and saves so", async () => {
    lib.skills = [skill("review")];
    await host.mount();
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
    await host.mount();
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

  it("deleting asks first and routes through the library", async () => {
    lib.skills = [skill("review")];
    await host.mount();
    act(() => row("review")!.click());
    act(() => button("Delete")!.click());

    // In-app confirm, not a system dialog.
    expect(document.body.textContent).toContain('Delete "review"?');
    const confirmDelete = confirmButton("Delete")!;
    await act(async () => confirmDelete.click());
    expect(lib.remove).toHaveBeenCalledWith({ kind: "global" }, "review");
  });

  it("guards unsaved edits behind a discard confirm on close", async () => {
    lib.skills = [skill("review")];
    await host.mount();
    act(() => row("review")!.click());
    type(input("skill-description"), "edited");

    act(() => buttonByTitle("Close skills")!.click());
    expect(host.closed()).toBe(0);
    expect(document.body.textContent).toContain("unsaved changes");

    act(() => button("Keep editing")!.click());
    expect(host.closed()).toBe(0);

    act(() => buttonByTitle("Close skills")!.click());
    act(() => button("Discard")!.click());
    expect(host.closed()).toBe(1);
  });
});
