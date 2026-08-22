/**
 * The skills editor's state machine: selection, dirty tracking, the two
 * confirm flows, and submit orchestration (rename-then-save).
 *
 * A hook rather than a plain module because the machine IS React state —
 * seven pieces of it, four refs, an effect, and two keyboard surfaces
 * that gate on the confirm. Handing a module every setter would be the
 * same coupling wearing a disguise.
 *
 * The refs-vs-state pairing is deliberate and load-bearing: the LATCHES
 * are synchronous (a second click must be refused within the tick, which
 * state cannot do — see `useLatch`), while `busy` and `deletingNow` are
 * state because buttons have to SHOW them. They are two facts at two
 * scopes, not one fact stored twice.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeSkillDescription,
  sameSkillRef,
  skillDraftOf,
  type SkillDraft,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import { useSkillsLibrary } from "../../app/useSkills";
import { useEscape } from "../../ui/useEscape";
import { useLatch } from "../../ui/useLatch";
import { useSaveShortcut } from "../../ui/useSaveShortcut";
import type { SkillsNavGroup } from "./SkillsNav";
import { buildSkillGroups, type GroupWorkspace } from "./skillGroups";
import {
  bundledRowAt,
  skillAt,
  skillFormVerdicts,
  type Selection,
  type SkillFormVerdicts,
  type WritableSelection,
} from "./skillFormVerdicts";

const EMPTY_FORM: SkillDraft = {
  name: "",
  description: "",
  body: "",
  extraFrontmatter: [],
};

/** A destructive step awaiting confirmation. The STATE lives here and
 * not in the shell because `apply` clears it and `navigate` raises it —
 * setting-rule and clearing-rule are one rule, and splitting them across
 * modules is how a confirm outlives the skill it names. The shell owns
 * only the dialogs that render it. */
export type SkillsConfirm =
  | { kind: "delete"; scope: SkillScope; name: string }
  | { kind: "discard"; next: Selection | null; closing?: boolean };

export interface SkillsEditorDeps {
  activeWs: GroupWorkspace | null;
  onClose(): void;
  canClose: boolean;
}

export function useSkillsEditor({
  activeWs,
  onClose,
  canClose,
}: SkillsEditorDeps) {
  const { skills, error, listTrusted, clearError, save, rename, remove } =
    useSkillsLibrary(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<SkillDraft>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  /** Whether the user has typed in the Name field — see `shownNameProblem`. */
  const [nameTouched, setNameTouched] = useState(false);
  /** The synchronous re-entry guards. A rename is not idempotent, and a
   * save racing a delete reports "No skill …" for an operation the user
   * did not get wrong. */
  const saving = useLatch();
  const deletingLatch = useLatch();
  /** The same two facts as STATE, because the buttons have to show it: a
   * write in flight must not just swallow the other write's click, or the
   * user is left pressing a button that does nothing. */
  const [busy, setBusy] = useState(false);
  /** A DELETE in flight, specifically. The nav freezes for this and not
   * for a save: navigating mid-delete bumps the epoch the delete's own
   * completion checks, so the editor is left on a skill that no longer
   * exists with no row to correct it with — whereas navigating mid-SAVE is
   * exactly what `navEpoch` exists to make safe. */
  const [deletingNow, setDeletingNow] = useState(false);
  // Navigation generation: bumped by every apply(). An in-flight submit
  // compares against it so its completion never clobbers a selection the
  // user moved somewhere else during the awaits.
  const navEpoch = useRef(0);
  // The live form object per render — an in-flight submit compares its
  // captured draft against this to tell whether the user typed during the
  // awaits (identity changes on every keystroke).
  const formRef = useRef(form);
  formRef.current = form;
  const [confirm, setConfirm] = useState<SkillsConfirm | null>(null);

  const groups = useMemo<SkillsNavGroup[]>(
    () => buildSkillGroups(skills, activeWs),
    // On the FIELDS, not the object: `activeWs` is built as a fresh literal by
    // the caller on every App render — and App re-renders on agent output, git
    // head polls and usage ticks — so depending on its identity rebuilt these
    // groups constantly, and with them the nav's parse-once memo downstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, activeWs?.id, activeWs?.name],
  );

  // Every verdict about the draft, from ONE reading of the world.
  const verdicts = skillFormVerdicts({
    selection,
    form,
    skills,
    listTrusted,
    busy,
    dirty,
    nameTouched,
  });

  useEffect(() => {
    if (verdicts.vanished && !dirty) apply(null);
    // `apply` and `dirty` are read fresh on each run; re-running on every render
    // would fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdicts.vanished, dirty]);

  /** The ONE bundled-vs-own routing decision: a bundled row opens the
   * read-only panel, everything else the edit machine. */
  const selectionFor = (skill: LibrarySkill): Selection =>
    skill.scope.kind === "bundled"
      ? { mode: "view", name: skill.name }
      : { mode: "edit", scope: skill.scope, name: skill.name };

  const openSkill = (skill: LibrarySkill) => {
    // The same projection the library's `read` uses, WHOLE — so the editor and
    // every other surface see one skill, not two readings of one file. It
    // already applies "the directory name wins over the frontmatter's".
    // The bundled tier hydrates through here too: view mode carries no scope
    // in the Selection, but the row in hand does — apply() routes BOTH modes
    // through this function, so the panel receives the row's content.
    setSelection(selectionFor(skill));
    setForm(skillDraftOf(skill));
    setDirty(false);
    setNameTouched(false);
  };

  /** Move the editor elsewhere, guarding unsaved edits behind a confirm. */
  const navigate = (next: Selection | null, closing?: boolean) => {
    // Clicking the row you are already editing must not raise a discard confirm
    // whose Discard throws the edits away — it is an easy stray click, because
    // that row is the highlighted one. With unsaved edits it does nothing at all;
    // clean, it is the natural "reload this row from disk" gesture.
    if (
      !closing &&
      next?.mode === "edit" &&
      selection?.mode === "edit" &&
      sameSkillRef(selection, next)
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
   * Run an async step of the current user action and say whether its outcome is
   * still THEIRS to see.
   *
   * The rule — "an outcome that arrives after the user moved on belongs to the
   * skill it happened to, not to whatever is on screen now" — was written out at
   * each async step, and the delete path held the opposite answer. One owner, so
   * the fourth step cannot get it wrong either.
   */
  const stillOurs = async (
    step: () => Promise<boolean>,
  ): Promise<{ ok: boolean; stale: boolean }> => {
    const nav = navEpoch.current;
    const ok = await step();
    const stale = navEpoch.current !== nav;
    // Only the REPORT is stale — the write itself ran, and the two facts have to
    // stay separate. Collapsing them into one verdict made a stale RENAME abort
    // the submit, so the directory moved, the content half of the same action was
    // dropped, and nothing re-read the library afterwards.
    if (stale && !ok) clearError();
    return { ok, stale };
  };

  const apply = (next: Selection | null, closing?: boolean) => {
    if (closing) {
      onClose();
      return;
    }
    // The user moved: any in-flight submit's terminal writes are stale now.
    navEpoch.current += 1;
    // And any confirmation still up was about where they were. It outlived the
    // skill it named when an agent deleted the open one.
    setConfirm(null);
    // A stale error belongs to the skill it happened on, not to wherever
    // the user navigates next.
    clearError();
    // Both selection modes route through openSkill — the one hydration home. A
    // row that vanished between click and now drops to the placeholder: an empty
    // panel claiming to show a skill that no longer ships would be a ghost.
    if (next?.mode === "view") {
      const row = bundledRowAt(skills, next.name);
      if (row) {
        openSkill(row);
        return;
      }
      next = null;
    }
    if (next?.mode === "edit") {
      const skill = skillAt(skills, next.scope, next.name);
      if (skill) {
        openSkill(skill);
        return;
      }
      next = null;
    }
    setSelection(next);
    setForm(EMPTY_FORM);
    setDirty(false);
    setNameTouched(false);
  };

  // While a confirm is up, Escape belongs to IT (useEscape handlers stack);
  // the dialog's own close must not race a re-confirm underneath.
  useEscape(() => navigate(null, true), canClose && !confirm);

  const submit = async () => {
    // THE narrowing point, and the only one. Past here the write machine
    // deals in WritableSelection, so it needs no guard of its own — a
    // bundled row cannot be handed to it at all.
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
   * The write machine.
   *
   * Its parameters are the WHOLE world it may consult: a selection it may
   * legally write, the draft it captured, and the verdicts already
   * reached. It is given no library, so it cannot form a second opinion
   * about whether the skill vanished — asking again would mean adding a
   * parameter, which is a change a reviewer sees.
   */
  const performSubmit = async (
    selection: WritableSelection,
    draftSource: SkillDraft,
    verdicts: SkillFormVerdicts,
  ) => {
    const scope = selection.scope;
    // An edited name moves the directory first (assets travel), then the
    // ordinary save lands the content under the new name.
    if (selection.mode === "edit" && draftSource.name !== selection.name) {
      const renamed = await stillOurs(() =>
        rename(scope, selection.name, draftSource.name),
      );
      if (!renamed.ok) return;
      // The save below runs whether or not the user moved on. The directory is
      // already renamed; abandoning the content write here left the edit
      // unwritten AND the library unread, because a rename deliberately does not
      // re-read — the save that follows owns that.
      if (!renamed.stale) {
        // From here the skill IS this name on disk, so the selection must say so
        // even if the content save fails, or `nameTaken` would treat our own new
        // name as a collision and dead-end the editor.
        setSelection({ mode: "edit", scope, name: draftSource.name });
      }
    }
    // A rename above has already moved the directory, so what lands now is an
    // overwrite of a skill that exists — only an untouched create is new.
    // `vanished` means the skill is not on disk any more, so what lands is a
    // create — which also gives the user a way out: retitle the draft and the
    // text is saved as a new skill instead of being stranded behind a dead Save.
    const mode =
      selection.mode === "create" || verdicts.vanished ? "create" : "update";
    const saved = await stillOurs(() => save(scope, draftSource, mode));
    if (saved.stale) return;
    if (saved.ok) {
      setSelection({ mode: "edit", scope, name: draftSource.name });
      // Keystrokes typed DURING the save are on screen but not on disk —
      // marking them clean would silently drop them at the next navigation.
      // Identity check: any setForm produced a new object.
      if (formRef.current === draftSource) {
        setDirty(false);
      }
    }
  };

  // ⌘S saves from anywhere in the dialog — the editor is a writing surface
  // and writers hit ⌘S by reflex. Like Escape above, it yields while a
  // confirm is up: saving underneath a delete/discard confirmation would
  // change the very state the user is deciding about.
  useSaveShortcut(() => {
    // Gated on `canClose` as well as our own confirm: while a transaction is
    // stacked over this dialog the surface is inert, so a write started here
    // would land — and report — where the user can neither see nor answer it.
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
    skills,
    error,
    listTrusted,
    groups,
    // What the editor is showing, and what may be done to it.
    selection,
    form,
    dirty,
    verdicts,
    creating: selection?.mode === "create",
    busy,
    deletingNow,
    confirm,
    // Transitions.
    selectionFor,
    navigate,
    submit,
    /** A field changed in the editor. The description is one YAML line by
     * contract; its textarea wraps for reading, so the domain's fold runs
     * here rather than letting a multi-line paste trip validation. */
    onField(key: keyof SkillDraft, value: string) {
      const next =
        key === "description" ? normalizeSkillDescription(value) : value;
      if (key === "name") setNameTouched(true);
      setForm((f) => ({ ...f, [key]: next }));
      setDirty(true);
    },
    requestDelete() {
      if (selection?.mode !== "edit") return;
      setConfirm({
        kind: "delete",
        scope: selection.scope,
        name: selection.name,
      });
    },
    confirmDelete,
    confirmDiscard,
    cancelConfirm: () => setConfirm(null),
  };
}
