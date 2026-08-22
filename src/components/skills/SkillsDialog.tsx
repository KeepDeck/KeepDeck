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
import { SkillViewer } from "./SkillViewer";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useSaveShortcut } from "../../ui/useSaveShortcut";
import { SkillEditor } from "./SkillEditor";
import { SkillsNav, type SkillsNavGroup } from "./SkillsNav";
import { buildSkillGroups, labelForScope } from "./skillGroups";
import {
  bundledRowAt,
  skillAt,
  skillFormVerdicts,
  type Selection,
} from "./skillFormVerdicts";

interface SkillsDialogProps {
  /** The active workspace, hosting the "This workspace" scope; `null` (no
   * workspace yet) leaves only the global scope. */
  activeWs: { id: string; name: string } | null;
  onClose(): void;
  /** False while a transaction is stacked over this dialog: `onClose` refuses
   * then, so Escape must not be claimed either. Distinct from this dialog's
   * OWN confirm, which it tracks itself. */
  canClose?: boolean;
}


const EMPTY_FORM: SkillDraft = {
  name: "",
  description: "",
  body: "",
  extraFrontmatter: [],
};

/**
 * The shared-skills manager — a full-screen editor over the library ([skills]):
 * one SKILL.md authored here reaches every CLI at its next spawn. This
 * component owns the STATE MACHINE — selection, dirty tracking, the two
 * confirm flows, submit orchestration (rename-then-save) and the keyboard
 * surface; rendering is delegated to `SkillsNav` (library) and `SkillEditor`
 * (panel). Unlike SettingsDialog's autonomous sections, the panel is a
 * CONTROLLED component on purpose — the state machine must own every
 * transition. Destructive steps confirm in-app, per the no-system-dialogs
 * rule.
 */
export function SkillsDialog({
  activeWs,
  onClose,
  canClose = true,
}: SkillsDialogProps) {
  const {
    skills,
    error,
    listTrusted,
    clearError,
    save,
    rename,
    remove,
  } = useSkillsLibrary(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<SkillDraft>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  /** Whether the user has typed in the Name field — see `shownNameProblem`. */
  const [nameTouched, setNameTouched] = useState(false);
  const submitting = useRef(false);
  /** A delete whose confirm has closed but whose IPC is still in flight — see
   * `submit`. */
  const deleting = useRef(false);
  /** The same two facts as STATE, because the buttons have to show it: a write
   * in flight must not just swallow the other write's click, or the user is left
   * pressing a button that does nothing. The refs stay for the synchronous
   * re-entry guard — state lands a render too late for that. */
  const [busy, setBusy] = useState(false);
  /** A DELETE in flight, specifically. The nav freezes for this and not for a
   * save: navigating mid-delete bumps the epoch the delete's own completion
   * checks, so the editor is left on a skill that no longer exists with no row to
   * correct it with — whereas navigating mid-SAVE is exactly what `navEpoch`
   * exists to make safe, and blocking it would take that away. */
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
  // A destructive step awaiting confirmation.
  const [confirm, setConfirm] = useState<
    | { kind: "delete"; scope: SkillScope; name: string }
    | { kind: "discard"; next: Selection | null; closing?: boolean }
    | null
  >(null);

  const groups = useMemo<SkillsNavGroup[]>(
    () => buildSkillGroups(skills, activeWs),
    // On the FIELDS, not the object: `activeWs` is built as a fresh literal by
    // the caller on every App render — and App re-renders on agent output, git
    // head polls and usage ticks — so depending on its identity rebuilt these
    // groups constantly, and with them the nav's parse-once memo downstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, activeWs?.id, activeWs?.name],
  );


  // Every verdict about the draft, reached in one place from one reading
  // of the world. The write machine downstream receives THIS object and
  // never the library, so it cannot form a second opinion.
  const verdicts = skillFormVerdicts({
    selection,
    form,
    skills,
    listTrusted,
    busy,
    dirty,
    nameTouched,
  });
  const { nameTaken, shownNameProblem, descriptionProblem, vanished, canSave } =
    verdicts;

  useEffect(() => {
    if (vanished && !dirty) apply(null);
    // `apply` and `dirty` are read fresh on each run; re-running on every render
    // would fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vanished, dirty]);

  /** The ONE bundled-vs-own routing decision: a bundled row opens the
   * read-only viewer, everything else the edit machine. openSkill and
   * the nav's onOpen both ask here — a new selection-entry path gets
   * the mapping for free instead of re-deriving (and mis-deriving) it. */
  const selectionFor = (skill: LibrarySkill): Selection =>
    skill.scope.kind === "bundled"
      ? { mode: "view", name: skill.name }
      : { mode: "edit", scope: skill.scope, name: skill.name };

  const openSkill = (skill: LibrarySkill) => {
    // The same projection the library's `read` uses, WHOLE — so the editor and
    // every other surface see one skill, not two readings of one file. It
    // already applies "the directory name wins over the frontmatter's";
    // re-asserting `name` here was that rule stated a second time, in the one
    // place that would keep the old answer when it changed.
    // The bundled tier hydrates through here too: view mode carries no scope
    // in the Selection, but the row in hand does — apply() routes BOTH modes
    // through this function, so the viewer receives the row's content (the
    // nav-click path once fell through to EMPTY_FORM and rendered blank).
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
    // clean, it is the natural "reload this row from disk" gesture, so it still
    // re-opens from the list and drops a stale error. (Returning outright skipped
    // both, and after an agent rewrites the open skill that click is the only
    // obvious way to pick the new bytes up.)
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
   * each async step, and the delete path held the opposite answer: it checked the
   * epoch to skip its own `apply`, and left the error to render under a different
   * skill. One owner, so the fourth step cannot get it wrong either.
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
    // skill it named when an agent deleted the open one: the editor was replaced by
    // the placeholder while `Delete "review"?` stayed on screen, and answering it
    // fired a write that could only fail.
    setConfirm(null);
    // A stale error belongs to the skill it happened on, not to wherever
    // the user navigates next.
    clearError();
    // Both selection modes route through openSkill — the one hydration
    // home. A view selection names a BUNDLED row (scope implied by the
    // mode); the row is resolved from the list like the edit branch
    // resolves its own, and a row that vanished between click and now
    // drops to the placeholder with the same honesty: an empty viewer
    // claiming to show a skill that no longer ships would be a ghost.
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
      // The target vanished between click and now (deleted, renamed) — an
      // empty editor claiming to edit it would be a ghost. Show the
      // placeholder instead.
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

  const creating = selection?.mode === "create";

  const submit = async () => {
    // The rename half is not idempotent: a double ⌘S entering twice would
    // replay rename(old→new) after the first one consumed "old" and paint
    // a spurious "Rename failed" over a rename that worked. `deleting` is the
    // same guard for the other in-flight destructive step: once its confirm has
    // closed, nothing else stopped a save racing the delete and reporting
    // "No skill …" for an operation the user did not get wrong.
    if (submitting.current || deleting.current || !selection || !canSave) return;
    submitting.current = true;
    setBusy(true);
    try {
      await performSubmit(selection);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const performSubmit = async (selection: Selection) => {
    // A view selection never reaches the write machine (routing sends
    // bundled rows to the viewer; this guard is the type-level backstop,
    // keyed on the same named policy as the derived guards above).
    if (selection.mode === "view") return;
    const scope = selection.scope;
    // `draftSource` catches typing during the awaits (newer keystrokes were NOT
    // saved and must stay dirty); `stillOurs` catches navigation.
    const draftSource = form;
    // An edited name moves the directory first (assets travel), then the
    // ordinary save lands the content under the new name.
    if (selection.mode === "edit" && form.name !== selection.name) {
      const renamed = await stillOurs(() => rename(scope, selection.name, form.name));
      if (!renamed.ok) return;
      // The save below runs whether or not the user moved on. The directory is
      // already renamed; abandoning the content write here left the edit unwritten
      // AND the library unread, because a rename deliberately does not re-read —
      // the save that follows owns that.
      if (!renamed.stale) {
        // From here the skill IS form.name on disk, so the selection must say so
        // even if the content save fails, or `nameTaken` would treat our own new
        // name as a collision and dead-end the editor.
        setSelection({ mode: "edit", scope, name: form.name });
      }
    }
    // A rename above has already moved the directory, so what lands now is an
    // overwrite of a skill that exists — only an untouched create is new. Named,
    // not a boolean: `true` said nothing about which of the two verbs' three
    // differences the caller was asking for.
    // `vanished` means the skill is not on disk any more, so what lands is a
    // create — which also gives the user a way out: retitle the draft and the text
    // is saved as a new skill instead of being stranded behind a dead Save.
    const mode = selection.mode === "create" || vanished ? "create" : "update";
    const saved = await stillOurs(() => save(scope, draftSource, mode));
    if (saved.stale) return;
    if (saved.ok) {
      setSelection({ mode: "edit", scope, name: draftSource.name });
      // Keystrokes typed DURING the save are on screen but not on disk —
      // marking them clean would silently drop them at the next
      // navigation. Identity check: any setForm produced a new object.
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
    // stacked over this dialog the surface is inert, so a write started here would
    // land — and report — where the user can neither see nor answer it. Escape
    // declines for the same reason one line up; ⌘S was checking only half of it.
    if (canClose && !confirm) void submit();
  });


  return (
    <ModalOverlay>
      <div className="form skills" role="dialog" aria-modal="true" aria-label="Skills">
        <div className="settings__head">
          <h2 className="form__title settings__title">Skills</h2>
          <CloseButton label="Close skills" onClick={() => navigate(null, true)} />
        </div>

        <div className="skills__body">
          <SkillsNav
            groups={groups}
            // Until the first read lands, an empty group must not claim the
            // library is empty — that is the reading `skills === null` exists to
            // keep off the screen, and the nav is what the user looks at.
            // "unknown" for ANY read that did not land, not only the first: with a
            // stale list in hand a scope with no rows would otherwise assert
            // "Nothing here yet" beside a notice saying the list may be out of date.
            emptyMeans={
              skills === null ? "loading" : listTrusted ? "empty" : "unknown"
            }
            busy={deletingNow}
            isActive={(skill) =>
              (selection?.mode === "edit" && sameSkillRef(selection, skill)) ||
              // View mode names a BUNDLED row: scope-checked, because in the
              // day-one union (a user-global `artifacts` beside the bundled
              // one) a name-only match highlights both rows.
              (selection?.mode === "view" &&
                skill.scope.kind === "bundled" &&
                selection.name === skill.name)
            }
            onOpen={(skill) => {
              navigate(selectionFor(skill));
            }}
            onCreate={(scope) => navigate({ mode: "create", scope })}
          />

          <section className="skills__editor">
            {selection === null ? (
              <div className="skills__placeholder">
                {skills === null ? (
                  "Loading…"
                ) : error !== null ? (
                  // A library that could not be READ renders as an empty one,
                  // and with nothing selected the editor — the only other
                  // place an error appears — is not mounted. Without this the
                  // dialog claims you simply have no skills.
                  <span
                    className="skills__placeholder-title kd-selectable"
                    role="alert"
                  >
                    {error}
                  </span>
                ) : (
                  <>
                    <span className="skills__placeholder-title">
                      One skill, every agent
                    </span>
                    <span>
                      Pick a skill on the left or create one — it reaches
                      Claude Code, Kimi, OpenCode and Codex worktrees at
                      their next session
                    </span>
                  </>
                )}
              </div>
            ) : selection.mode === "view" ? (
              <SkillViewer draft={form} />
            ) : (
              <SkillEditor
                // NOT keyed per selection. That remounted the editor whenever
                // `selection` changed — which `performSubmit` does mid-submit, on
                // create→edit and again on a rename — tearing down the fields the
                // user was typing into and dropping focus, caret and scroll. The
                // create form's focus is the editor's own business now.
                creating={creating}
                savedName={selection.mode === "edit" ? selection.name : null}
                scopeLabel={labelForScope(groups, selection.scope)}
                form={form}
                dirty={dirty}
                validation={{
                  nameProblem: shownNameProblem,
                  nameTaken,
                  descriptionProblem,
                  vanished,
                }}
                canSave={canSave}
                error={error}
                onField={(key, value) => {
                  // The description is one YAML line by contract (see
                  // skillDescriptionProblem); its textarea wraps for
                  // reading, so a multi-line paste folds to spaces here
                  // instead of tripping validation.
                  const next =
                    key === "description" ? normalizeSkillDescription(value) : value;
                  if (key === "name") setNameTouched(true);
                  setForm((f) => ({ ...f, [key]: next }));
                  setDirty(true);
                }}
                onSubmit={() => void submit()}
                busy={busy}
                onDelete={() =>
                  selection.mode === "edit" &&
                  setConfirm({
                    kind: "delete",
                    scope: selection.scope,
                    name: selection.name,
                  })
                }
              />
            )}
          </section>
        </div>
      </div>

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title="Delete skill"
          message={`Delete "${confirm.name}"? Agents lose it on their next session`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => {
            // Through the SAME owner every other async step uses, so this path
            // stops being the one that checked the epoch for its own `apply` and
            // left the error to render under a different skill.
            const target = confirm;
            deleting.current = true;
            setBusy(true);
            setDeletingNow(true);
            void stillOurs(() => remove(target.scope, target.name))
              .then(({ ok, stale }) => {
                if (ok && !stale) apply(null);
              })
              .finally(() => {
                deleting.current = false;
                setBusy(false);
                setDeletingNow(false);
              });
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "discard" && (
        <ConfirmDialog
          title="Discard changes"
          message="This skill has unsaved changes"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            setDirty(false);
            setConfirm(null);
            apply(confirm.next, confirm.closing);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </ModalOverlay>
  );
}
