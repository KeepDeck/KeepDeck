// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryState } from "../../app/useLibraryState";
import { libraryVerdicts, type NameProblem } from "./libraryVerdicts";
import { useLibraryEditor, type EditorWorld } from "./useLibraryEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The machine driven bare — no dialog, no fields — over the smallest library
 * that has both a writable scope and a read-only tier. What the two dialogs
 * share is pinned HERE, once; each dialog's own suite keeps only what its
 * markup adds.
 */
type Scope = "lib" | "tier";
type WriteScope = "lib";
interface Row {
  scope: Scope;
  name: string;
  text: string;
}
interface Form {
  name: string;
  text: string;
}

const nameProblemOf = (name: string): NameProblem =>
  name === "" ? "empty" : /^[a-z-]+$/.test(name) ? null : "invalid";
const rowAt = (rows: Row[] | null, scope: WriteScope, name: string) =>
  (rows ?? []).find((r) => r.scope === scope && r.name === name);
const verdicts = (world: EditorWorld<WriteScope, Row, Form>) => {
  const { retitled, ...shared } = libraryVerdicts({ ...world, rowAt, nameProblemOf });
  const canSave =
    world.selection !== null &&
    !shared.isView &&
    world.dirty &&
    (!shared.vanished || retitled) &&
    shared.nameProblem === null &&
    !shared.nameTaken;
  return { ...shared, canSave };
};

/** The library as the hook sees it: rows the writes LAND in, the way the
 * real state's re-read makes them, and writes that can be held open. */
function fakeLibrary(rows: Row[]) {
  const lib = {
    rows: rows as Row[] | null,
    error: null as string | null,
    listTrusted: true,
    clearError: vi.fn(),
    save: vi.fn(async (scope: WriteScope, draft: Form, mode: "create" | "update") => {
      const landed: Row = { scope, name: draft.name, text: draft.text };
      lib.rows =
        mode === "create"
          ? [...(lib.rows ?? []), landed]
          : (lib.rows ?? []).map((r) => (r.scope === scope && r.name === draft.name ? landed : r));
      return true;
    }),
    rename: vi.fn(async (scope: WriteScope, from: string, to: string) => {
      lib.rows = (lib.rows ?? []).map((r) => (r.scope === scope && r.name === from ? { ...r, name: to } : r));
      return true;
    }),
    remove: vi.fn(async (scope: WriteScope, name: string) => {
      lib.rows = (lib.rows ?? []).filter((r) => !(r.scope === scope && r.name === name));
      return true;
    }),
  };
  return lib;
}
type FakeLibrary = ReturnType<typeof fakeLibrary>;

type Machine = ReturnType<typeof useLibraryEditor<Scope, WriteScope, Row, Form, Form, ReturnType<typeof verdicts>>>;
let latest: Machine;
const onClose = vi.fn();

function Harness({ state }: { state: LibraryState<WriteScope, Row, Form> }) {
  latest = useLibraryEditor<Scope, WriteScope, Row, Form, Form, ReturnType<typeof verdicts>>({
    state,
    emptyForm: { name: "", text: "" },
    formOf: (row) => ({ name: row.name, text: row.text }),
    draftOf: (form) => form,
    rowAt,
    writeScopeOf: (row) => (row.scope === "tier" ? null : row.scope),
    viewRowAt: (rows, name) => (rows ?? []).find((r) => r.scope === "tier" && r.name === name),
    sameRef: (a, b) => a.scope === b.scope && a.name === b.name,
    verdicts,
    onClose,
    canClose: true,
  });
  return null;
}

let root: Root;
let lib: FakeLibrary;
/** Render the hook over the library AS IT IS NOW — after a write landed,
 * the way the real state re-renders its readers. */
const render = () => act(() => root.render(createElement(Harness, { state: { ...lib } })));
const review: Row = { scope: "lib", name: "review", text: "About review" };
const deploy: Row = { scope: "lib", name: "deploy", text: "About deploy" };
const shipped: Row = { scope: "tier", name: "artifacts", text: "Shipped" };
const open = (row: Row) => act(() => latest.navigate(latest.selectionFor(row)));

beforeEach(() => {
  lib = fakeLibrary([review, deploy, shipped]);
  onClose.mockClear();
  document.body.innerHTML = "<div id='host'></div>";
  root = createRoot(document.getElementById("host")!);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the library editor machine", () => {
  it("routes a row to the edit machine or the view panel by whether it can be written back", async () => {
    await render();
    expect(latest.selectionFor(review)).toEqual({ mode: "edit", scope: "lib", name: "review" });
    expect(latest.selectionFor(shipped)).toEqual({ mode: "view", name: "artifacts" });
    await open(review);
    expect(latest.form).toEqual({ name: "review", text: "About review" });
    expect(latest.isActive(review)).toBe(true);
    expect(latest.isActive(deploy)).toBe(false);
    expect(latest.isActive(shipped)).toBe(false);
    await open(shipped);
    expect(latest.verdicts.isView).toBe(true);
    expect(latest.isActive(shipped)).toBe(true);
    expect(latest.isActive(review)).toBe(false);
  });

  it("reads a view row LIVE — the panel follows the list, not the click", async () => {
    await render();
    await open(shipped);
    expect(latest.form.text).toBe("Shipped");
    lib.rows = [review, deploy, { ...shipped, text: "Shipped, now with an invocation" }];
    await render();
    expect(latest.viewRow?.text).toBe("Shipped, now with an invocation");
    expect(latest.form.text).toBe("Shipped, now with an invocation");
  });

  it("says what an empty group means: loading, unknown after a failed read, else empty", async () => {
    lib.rows = null;
    await render();
    expect(latest.emptyMeans).toBe("loading");
    lib.rows = [];
    lib.listTrusted = false;
    await render();
    expect(latest.emptyMeans).toBe("unknown");
    lib.listTrusted = true;
    await render();
    expect(latest.emptyMeans).toBe("empty");
  });

  it("ignores a field event carrying the value the field already holds", async () => {
    await render();
    await open(review);
    act(() => latest.onField("text", "About review"));
    expect(latest.dirty).toBe(false);
    act(() => latest.onField("text", "About review, edited"));
    expect(latest.dirty).toBe(true);
  });

  it("does not raise a discard confirm for a click on the item already open", async () => {
    await render();
    await open(review);
    act(() => latest.onField("text", "edited"));
    await open(review);
    // That click asked for nothing: the confirm's Discard would have thrown
    // the edits away, and the row is the highlighted one so a stray click is
    // easy. Clean, the same click is the natural "reload from disk".
    expect(latest.confirm).toBeNull();
    expect(latest.form.text).toBe("edited");
  });

  it("holds the nav while a delete is in flight, and drops the editor once it lands", async () => {
    let finish!: (ok: boolean) => void;
    lib.remove.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    await render();
    await open(review);
    act(() => latest.requestDelete());
    expect(latest.confirm).toEqual({ kind: "delete", scope: "lib", name: "review" });
    act(() => latest.confirmDelete());
    expect(latest.deletingNow).toBe(true);
    expect(latest.busy).toBe(true);
    await act(async () => finish(true));
    expect(latest.deletingNow).toBe(false);
    expect(latest.selection).toBeNull();
  });

  it("a rename whose save the user navigated away from still WRITES the content", async () => {
    // The staleness rule governs the REPORT, not the operation: the
    // directory moved, so the content half of the same action must land.
    let finishRename!: (ok: boolean) => void;
    lib.rename.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishRename = resolve)));
    await render();
    await open(review);
    act(() => latest.onField("name", "deep-review"));
    act(() => latest.onField("text", "the edit that must still land"));
    let submitted!: Promise<void>;
    act(() => {
      submitted = latest.submit();
    });
    // Navigating mid-save is allowed — the discard confirm guards it.
    await open(deploy);
    act(() => latest.confirmDiscard());
    await act(async () => finishRename(true));
    await act(async () => submitted);
    expect(lib.save).toHaveBeenCalledWith(
      "lib",
      { name: "deep-review", text: "the edit that must still land" },
      "update",
    );
    // …and the user was not yanked back.
    expect(latest.selection).toEqual({ mode: "edit", scope: "lib", name: "deploy" });
  });

  it("a failed save after a successful rename is retryable, not a dead end", async () => {
    lib.save.mockResolvedValueOnce(false);
    await render();
    await open(review);
    act(() => latest.onField("name", "deep-review"));
    await act(async () => latest.submit());
    // The item IS the new name on disk now; the editor follows, so its own
    // name is not a collision and the retry is a plain save.
    expect(latest.selection).toEqual({ mode: "edit", scope: "lib", name: "deep-review" });
    await render();
    expect(latest.verdicts.nameTaken).toBe(false);
    expect(latest.verdicts.canSave).toBe(true);
    await act(async () => latest.submit());
    expect(lib.rename).toHaveBeenCalledTimes(1);
    expect(lib.save).toHaveBeenLastCalledWith("lib", expect.objectContaining({ name: "deep-review" }), "update");
  });

  it("a double submit runs once — a rename is not idempotent", async () => {
    let release!: (ok: boolean) => void;
    lib.rename.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)));
    await render();
    await open(review);
    act(() => latest.onField("name", "deep-review"));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = latest.submit();
      second = latest.submit();
    });
    await act(async () => release(true));
    await act(async () => Promise.all([first, second]));
    expect(lib.rename).toHaveBeenCalledTimes(1);
  });

  it("keystrokes typed DURING a save stay dirty — never silently dropped", async () => {
    let releaseSave!: (ok: boolean) => void;
    lib.save.mockImplementationOnce(() => new Promise<boolean>((resolve) => (releaseSave = resolve)));
    await render();
    await open(review);
    act(() => latest.onField("text", "first edit"));
    let submitted!: Promise<void>;
    act(() => {
      submitted = latest.submit();
    });
    act(() => latest.onField("text", "first edit plus more"));
    await act(async () => releaseSave(true));
    await act(async () => submitted);
    // The newer text is on screen, NOT on disk.
    expect(latest.form.text).toBe("first edit plus more");
    expect(latest.dirty).toBe(true);
    expect(lib.save).toHaveBeenCalledWith("lib", { name: "review", text: "first edit" }, "update");
  });

  it("a stale operation error clears when navigating elsewhere", async () => {
    lib.error = "Save failed: disk full";
    await render();
    await open(review);
    await open(deploy);
    expect(lib.clearError).toHaveBeenCalled();
  });

  it("a vanished discard target falls back to the placeholder, not a ghost editor", async () => {
    await render();
    await open(review);
    act(() => latest.onField("text", "edited"));
    await open(deploy); // the discard confirm captures the target
    expect(latest.confirm).toMatchObject({ kind: "discard" });
    lib.rows = [review, shipped]; // "deploy" vanishes meanwhile
    await render();
    act(() => latest.confirmDiscard());
    expect(latest.selection).toBeNull();
  });

  it("refuses to save an item deleted elsewhere, drops a clean editor, and keeps a dirty one", async () => {
    await render();
    await open(review);
    lib.rows = [deploy, shipped];
    await render();
    // Clean: gone from under the user with nothing to lose — placeholder.
    expect(latest.selection).toBeNull();

    await open(deploy);
    act(() => latest.onField("text", "unsaved"));
    lib.rows = [shipped];
    await render();
    expect(latest.verdicts.vanished).toBe(true);
    expect(latest.verdicts.canSave).toBe(false);
    expect(latest.selection).toEqual({ mode: "edit", scope: "lib", name: "deploy" });
    // The retitle hatch: a new name turns the save into a create.
    act(() => latest.onField("name", "deploy-two"));
    expect(latest.verdicts.canSave).toBe(true);
    await act(async () => latest.submit());
    expect(lib.rename).not.toHaveBeenCalled();
    expect(lib.save).toHaveBeenCalledWith("lib", { name: "deploy-two", text: "unsaved" }, "create");
  });

  it("closes through the same guard: a dirty editor asks first, a clean one just closes", async () => {
    await render();
    await open(review);
    act(() => latest.navigate(null, true));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => latest.onField("text", "edited"));
    act(() => latest.navigate(null, true));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(latest.confirm).toEqual({ kind: "discard", next: null, closing: true });
    act(() => latest.confirmDiscard());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
