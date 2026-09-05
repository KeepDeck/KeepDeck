/**
 * A library editor's state machine: selection, dirty tracking, the two
 * confirm flows, and submit orchestration (rename-then-save).
 *
 * Generic over the item because two libraries share every transition here
 * — which row is open, whether the draft is dirty, what a stray click on the
 * open row means, how a rename lands before its save, whose outcome a late
 * write belongs to — and none of it mentions what a skill or a server is.
 * What differs is handed in as [`LibraryEditorConfig`]: the form the editor
 * edits, how a row becomes one and one becomes a draft, and the verdicts the
 * library reaches about it.
 *
 * A hook rather than a plain module because the machine IS React state —
 * seven pieces of it, four refs, an effect, and two keyboard surfaces that
 * gate on the confirm. The refs-vs-state pairing is deliberate and
 * load-bearing: the LATCHES are synchronous (a second click must be refused
 * within the tick, which state cannot do — see `useLatch`), while `busy` and
 * `deletingNow` are state because buttons have to SHOW them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryState } from "../../app/useLibraryState";
import { useEscape } from "../../ui/useEscape";
import { useLatch } from "../../ui/useLatch";
import { useSaveShortcut } from "../../ui/useSaveShortcut";
import type { Selection, WritableSelection } from "./libraryVerdicts";

/** The keys of a form the editor types into. */
export type StringKeys<Form> = {
  [K in keyof Form]: Form[K] extends string ? K : never;
}[keyof Form] &
  string;

/** What the machine needs from a library's verdicts — the rest is the
 * library's own and rides through to the shell untouched. */
export interface EditorVerdicts {
  isView: boolean;
  vanished: boolean;
  canSave: boolean;
}

/** The world a library's verdict function is handed. */
export interface EditorWorld<WriteScope, Row, Form> {
  selection: Selection<WriteScope> | null;
  form: Form;
  rows: Row[] | null;
  listTrusted: boolean;
  busy: boolean;
  dirty: boolean;
  nameTouched: boolean;
}

/** A destructive step awaiting confirmation. The STATE lives here and not
 * in the shell because `apply` clears it and `navigate` raises it —
 * setting-rule and clearing-rule are one rule, and splitting them across
 * modules is how a confirm outlives the item it names. The shell owns only
 * the dialogs that render it. */
export type LibraryConfirm<WriteScope> =
  | { kind: "delete"; scope: WriteScope; name: string }
  | { kind: "discard"; next: Selection<WriteScope> | null; closing?: boolean };

/**
 * Two scope types, on purpose. `Scope` is what a ROW carries — every group
 * the nav shows, a read-only tier included. `WriteScope` is what the library
 * STORES into, and the only scope an edit, a create or a write ever names.
 * Keeping them one type meant every writer took a scope it had to refuse at
 * runtime; splitting them makes the tier unwritable by construction.
 */
export interface LibraryEditorConfig<
  Scope,
  WriteScope extends Scope,
  Row extends { scope: Scope; name: string },
  Form extends { name: string },
  Draft,
  Verdicts extends EditorVerdicts,
> {
  /** The library as view state — see [`useLibraryState`]. */
  state: LibraryState<WriteScope, Row, Draft>;
  emptyForm: Form;
  /** A stored row as the form the editor edits — the ONE hydration home,
   * so the editor and every other surface see one reading of a file. */
  formOf(row: Row): Form;
  /** The form as the library takes it. Identity when the two coincide. */
  draftOf(form: Form): Draft;
  /** The listed row at (scope, name). */
  rowAt(rows: Row[] | null, scope: WriteScope, name: string): Row | undefined;
  /** The scope a row can be written back to — `null` for a row of the
   * read-only tier, which opens the view panel instead of the edit machine.
   * THE routing decision, and the one narrowing from a row's scope to a
   * writable one. */
  writeScopeOf(row: Row): WriteScope | null;
  /** The read-only row at `name` — a view selection carries no scope. */
  viewRowAt(rows: Row[] | null, name: string): Row | undefined;
  /** Whether two references name the SAME item. */
  sameRef(
    a: { scope: WriteScope; name: string },
    b: { scope: WriteScope; name: string },
  ): boolean;
  /** Every verdict about the draft, from ONE reading of the world. */
  verdicts(world: EditorWorld<WriteScope, Row, Form>): Verdicts;
  /** A field's value as the form stores it — a library's chance to fold
   * what its format cannot carry (a pasted newline in a one-line field). */
  normalizeField?(key: StringKeys<Form>, value: string): string;
  onClose(): void;
  canClose: boolean;
}

export function useLibraryEditor<
  Scope,
  WriteScope extends Scope,
  Row extends { scope: Scope; name: string },
  Form extends { name: string },
  Draft,
  Verdicts extends EditorVerdicts,
>(config: LibraryEditorConfig<Scope, WriteScope, Row, Form, Draft, Verdicts>) {
  const {
    state,
    emptyForm,
    formOf,
    draftOf,
    rowAt,
    writeScopeOf,
    viewRowAt,
    sameRef,
    onClose,
    canClose,
  } = config;
  const { rows, listTrusted, clearError, save, rename, remove } = state;
  const [selection, setSelection] = useState<Selection<WriteScope> | null>(null);
  const [edited, setForm] = useState<Form>(emptyForm);
  const [dirty, setDirty] = useState(false);
  /** Whether the user has typed in the Name field — see `shownNameProblem`. */
  const [nameTouched, setNameTouched] = useState(false);
  /** The synchronous re-entry guards. A rename is not idempotent, and a
   * save racing a delete reports "No … " for an operation the user did not
   * get wrong. */
  const saving = useLatch();
  const deletingLatch = useLatch();
  /** The same two facts as STATE, because the buttons have to show it. */
  const [busy, setBusy] = useState(false);
  /** A DELETE in flight, specifically. The nav freezes for this and not for
   * a save: navigating mid-delete bumps the epoch the delete's own completion
   * checks, so the editor is left on an item that no longer exists with no
   * row to correct it with. */
  const [deletingNow, setDeletingNow] = useState(false);
  // Navigation generation: bumped by every apply(). An in-flight submit
  // compares against it so its completion never clobbers a selection the
  // user moved somewhere else during the awaits.
  const navEpoch = useRef(0);
  const [confirm, setConfirm] = useState<LibraryConfirm<WriteScope> | null>(null);

  /** The row a view selection shows, read from the LIST on every render:
   * a read-only row can change under the panel (the deck's own server fills
   * in its invocation once the socket is up), and a form captured at click
   * time would keep showing what the row said then. */
  const viewRow = selection?.mode === "view" ? (viewRowAt(rows, selection.name) ?? null) : null;
  const viewForm = useMemo(() => (viewRow ? formOf(viewRow) : null), [viewRow, formOf]);
  const form = viewForm ?? edited;
  // The live form object per render — an in-flight submit compares its
  // captured draft against this to tell whether the user typed during the
  // awaits (identity changes on every keystroke).
  const formRef = useRef(form);
  formRef.current = form;

  // Every verdict about the draft, from ONE reading of the world.
  const verdicts = config.verdicts({
    selection,
    form,
    rows,
    listTrusted,
    busy,
    dirty,
    nameTouched,
  });

  useEffect(() => {
    if (verdicts.vanished && !dirty) apply(null);
    // `apply` and `dirty` are read fresh on each run; re-running on every
    // render would fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdicts.vanished, dirty]);

  /** The ONE read-only-vs-own routing decision: a row with no scope to
   * write back to opens the read-only panel, everything else the edit
   * machine. */
  const selectionFor = (row: Row): Selection<WriteScope> => {
    const scope = writeScopeOf(row);
    return scope === null
      ? { mode: "view", name: row.name }
      : { mode: "edit", scope, name: row.name };
  };

  /** Whether a listed row is the one the editor shows — the nav's highlight.
   * Through `selectionFor`, so a row is active exactly when clicking it
   * would open what is already open. */
  const isActive = (row: Row): boolean => {
    if (!selection) return false;
    const target = selectionFor(row);
    if (target.mode === "view") return selection.mode === "view" && selection.name === target.name;
    return target.mode === "edit" && selection.mode === "edit" && sameRef(selection, target);
  };

  const openRow = (row: Row) => {
    // Both selection modes route through here — the one hydration home.
    setSelection(selectionFor(row));
    setForm(formOf(row));
    setDirty(false);
    setNameTouched(false);
  };

  /** Move the editor elsewhere, guarding unsaved edits behind a confirm. */
  const navigate = (next: Selection<WriteScope> | null, closing?: boolean) => {
    // Clicking the row you are already editing must not raise a discard
    // confirm whose Discard throws the edits away — it is an easy stray
    // click, because that row is the highlighted one. With unsaved edits it
    // does nothing at all; clean, it is the natural "reload from disk".
    if (
      !closing &&
      next?.mode === "edit" &&
      selection?.mode === "edit" &&
      sameRef(selection, next)
    ) {
      if (!dirty) apply(next);
      return;
    }
    if (dirty) {
      setConfirm({ kind: "discard", next, closing });
      return;
    }
    apply(next, closing);
  };

  /**
   * Run an async step of the current user action and say whether its outcome
   * is still THEIRS to see: an outcome that arrives after the user moved on
   * belongs to the item it happened to, not to whatever is on screen now.
   */
  const stillOurs = async (
    step: () => Promise<boolean>,
  ): Promise<{ ok: boolean; stale: boolean }> => {
    const nav = navEpoch.current;
    const ok = await step();
    const stale = navEpoch.current !== nav;
    // Only the REPORT is stale — the write itself ran, and the two facts have
    // to stay separate: collapsing them made a stale RENAME abort the submit.
    if (stale && !ok) clearError();
    return { ok, stale };
  };

  const apply = (next: Selection<WriteScope> | null, closing?: boolean) => {
    if (closing) {
      onClose();
      return;
    }
    // The user moved: any in-flight submit's terminal writes are stale now.
    navEpoch.current += 1;
    // And any confirmation still up was about where they were.
    setConfirm(null);
    // A stale error belongs to the item it happened on.
    clearError();
    // A row that vanished between click and now drops to the placeholder: an
    // empty panel claiming to show an item that no longer exists is a ghost.
    if (next?.mode === "view") {
      const row = viewRowAt(rows, next.name);
      if (row) {
        openRow(row);
        return;
      }
      next = null;
    }
    if (next?.mode === "edit") {
      const row = rowAt(rows, next.scope, next.name);
      if (row) {
        openRow(row);
        return;
      }
      next = null;
    }
    setSelection(next);
    setForm(emptyForm);
    setDirty(false);
    setNameTouched(false);
  };

  // While a confirm is up, Escape belongs to IT (useEscape handlers stack).
  useEscape(() => navigate(null, true), canClose && !confirm);

  const submit = async () => {
    // THE narrowing point, and the only one. Past here the write machine
    // deals in WritableSelection, so it needs no guard of its own.
    if (
      !selection ||
      selection.mode === "view" ||
      !verdicts.canSave ||
      deletingLatch.held ||
      !saving.acquire()
    ) {
      return;
    }
    setBusy(true);
    try {
      await performSubmit(selection, form, verdicts);
    } finally {
      saving.release();
      setBusy(false);
    }
  };

  /**
   * The write machine. Its parameters are the WHOLE world it may consult: a
   * selection it may legally write, the form it captured, and the verdicts
   * already reached. It is given no library, so it cannot form a second
   * opinion about whether the item vanished.
   */
  const performSubmit = async (
    selection: WritableSelection<WriteScope>,
    captured: Form,
    verdicts: Verdicts,
  ) => {
    const scope = selection.scope;
    // An edited name moves the item first, then the ordinary save lands the
    // content under the new name. NOT when the item vanished: there is
    // nothing on disk to move, and failing here would shut the retitle hatch
    // one step further along than the gate did.
    if (selection.mode === "edit" && !verdicts.vanished && captured.name !== selection.name) {
      const renamed = await stillOurs(() => rename(scope, selection.name, captured.name));
      if (!renamed.ok) return;
      // The save below runs whether or not the user moved on: the item is
      // already renamed, and a rename deliberately does not re-read.
      if (!renamed.stale) {
        // From here the item IS this name on disk, so the selection must say
        // so even if the content save fails, or `nameTaken` would treat our
        // own new name as a collision and dead-end the editor.
        setSelection({ mode: "edit", scope, name: captured.name });
      }
    }
    // A rename above has already moved the item, so what lands now is an
    // overwrite of one that exists — only an untouched create is new.
    // `vanished` means the item is not on disk any more, so what lands is a
    // create: the retitle hatch.
    const mode = selection.mode === "create" || verdicts.vanished ? "create" : "update";
    const saved = await stillOurs(() => save(scope, draftOf(captured), mode));
    if (saved.stale) return;
    if (saved.ok) {
      setSelection({ mode: "edit", scope, name: captured.name });
      // Keystrokes typed DURING the save are on screen but not on disk —
      // marking them clean would silently drop them at the next navigation.
      if (formRef.current === captured) setDirty(false);
    }
  };

  // ⌘S saves from anywhere in the dialog. Like Escape above, it yields while
  // a confirm is up, and while a transaction is stacked over the dialog.
  useSaveShortcut(() => {
    if (canClose && !confirm) void submit();
  });

  const confirmDelete = () => {
    if (confirm?.kind !== "delete") return;
    const target = confirm;
    if (!deletingLatch.acquire()) return;
    setBusy(true);
    setDeletingNow(true);
    void stillOurs(() => remove(target.scope, target.name))
      .then(({ ok, stale }) => {
        if (ok && !stale) apply(null);
      })
      .finally(() => {
        deletingLatch.release();
        setBusy(false);
        setDeletingNow(false);
      });
    setConfirm(null);
  };

  const confirmDiscard = () => {
    if (confirm?.kind !== "discard") return;
    setDirty(false);
    setConfirm(null);
    apply(confirm.next, confirm.closing);
  };

  return {
    // The library, as the shell must report it.
    rows,
    error: state.error,
    listTrusted,
    /** What an EMPTY group means right now — "unknown" for a read that did
     * not land, the first one or a later one: with a stale list in hand a
     * scope with no rows must not assert "Nothing here yet" beside a notice
     * saying the list may be out of date. */
    emptyMeans: (rows === null ? "loading" : listTrusted ? "empty" : "unknown") as
      | "loading"
      | "unknown"
      | "empty",
    // What the editor is showing, and what may be done to it.
    selection,
    form,
    /** The read-only row on show, live from the list; null otherwise. */
    viewRow,
    dirty,
    verdicts,
    creating: selection?.mode === "create",
    busy,
    deletingNow,
    confirm,
    // Transitions.
    selectionFor,
    isActive,
    navigate,
    submit,
    /** A field changed in the editor. A value equal to what the field holds
     * (a focus/blur cycle, a paste of the same text) changes nothing — and
     * must not mark the draft dirty, or a discard confirm guards nothing. */
    onField(key: StringKeys<Form>, value: string) {
      const next = config.normalizeField ? config.normalizeField(key, value) : value;
      if (formRef.current[key] === next) return;
      if (key === "name") setNameTouched(true);
      setForm((current) => ({ ...current, [key]: next }));
      setDirty(true);
    },
    requestDelete() {
      if (selection?.mode !== "edit") return;
      setConfirm({ kind: "delete", scope: selection.scope, name: selection.name });
    },
    confirmDelete,
    confirmDiscard,
    cancelConfirm: () => setConfirm(null),
  };
}
