import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeSkillDescription,
  sameSkillRef,
  sameSkillScope,
  skillDescriptionProblem,
  skillDraftOf,
  skillNameProblem,
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

/** Which stored skill the editor shows, or the create form for a scope.
 * The view mode is the read-only BUNDLED row: the write machine (submit,
 * rename, delete, dirty tracking, the confirms) never sees a bundled
 * skill BY CONSTRUCTION — no gating branches inside it. */
type Selection =
  | { mode: "edit"; scope: SkillScope; name: string }
  | { mode: "view"; name: string }
  | { mode: "create"; scope: SkillScope };

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

  const groups = useMemo<SkillsNavGroup[]>(() => {
    const all = skills ?? [];
    const built: SkillsNavGroup[] = [
      {
        label: "Global",
        scope: { kind: "global" },
        // Through the domain predicate, like every other membership test in
        // this file: a raw field comparison here would silently stop agreeing
        // with them the moment a scope means anything new.
        items: all.filter((s) => sameSkillScope(s.scope, { kind: "global" })),
      },
    ];
    if (activeWs) {
      const scope: SkillScope = { kind: "workspace", wsId: activeWs.id };
      built.push({
        label: activeWs.name,
        scope,
        items: all.filter((s) => sameSkillScope(s.scope, scope)),
      });
    }
    // The bundled tier LAST (user content outranks app content on the
    // user's machine) — rows render from the list, both a user-global
    // and the bundled same-name row visible side by side (namespaces at
    // rest; resolution-by-name lives in staging alone).
    const bundled = all.filter((s) => s.scope.kind === "bundled");
    if (bundled.length > 0) {
      built.push({
        label: "Bundled",
        scope: { kind: "bundled" },
        items: bundled,
      });
    }
    return built;
    // On the FIELDS, not the object: `activeWs` is built as a fresh literal by the
    // caller on every App render — and App re-renders on agent output, git head
    // polls and usage ticks — so depending on its identity rebuilt these groups
    // constantly, and with them the nav's parse-once memo downstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, activeWs?.id, activeWs?.name]);

  /** The listed skill at (scope, name) — "which row IS this one" asked once,
   * where three sites had each spelled out the compound comparison. The library
   * asks the same question of the disk; if identity ever grows (case-insensitive
   * names, trimming), these are the two places that must move together. */
  const skillAt = (scope: SkillScope, name: string): LibrarySkill | undefined =>
    (skills ?? []).find((s) => sameSkillRef(s, { scope, name }));

  /** The open skill is gone from the library — an agent deleted or renamed it
   * under us. The list reconciles itself through the subscription; the SELECTION
   * did not, so the editor kept a title, a body and a live Save that could only
   * ever answer "No skill …". Clean, we drop to the placeholder; dirty, the user's
   * text stays on screen and Save is refused with a reason, because throwing away
   * what they typed is the one thing worse than a stale editor. */
  const vanished =
    selection?.mode === "edit" &&
    skills !== null &&
    // NOT while one of our own writes is in flight: a rename re-anchors the
    // selection to a name the list does not hold yet — by design, since the save
    // that follows owns the re-read — so judging it mid-submit calls every rename
    // a disappearance and disables the save that would complete it. And not over a
    // list whose last read failed, where absence proves nothing at all.
    !busy &&
    listTrusted &&
    skillAt(selection.scope, selection.name) === undefined;

  useEffect(() => {
    if (vanished && !dirty) apply(null);
    // `apply` and `dirty` are read fresh on each run; re-running on every render
    // would fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vanished, dirty]);

  const openSkill = (skill: LibrarySkill) => {
    // The same projection the library's `read` uses, WHOLE — so the editor and
    // every other surface see one skill, not two readings of one file. It
    // already applies "the directory name wins over the frontmatter's";
    // re-asserting `name` here was that rule stated a second time, in the one
    // place that would keep the old answer when it changed.
    if (skill.scope.kind === "bundled") {
      // The read-only tier: view mode, never the edit machine. The form
      // still receives the draft (the viewer projects it), but the write
      // machinery keys on selection.mode and so never fires for a view.
      setSelection({ mode: "view", name: skill.name });
      setForm(skillDraftOf(skill));
      setDirty(false);
      setNameTouched(false);
      return;
    }
    setSelection({ mode: "edit", scope: skill.scope, name: skill.name });
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
    if (next?.mode === "edit") {
      const skill = skillAt(next.scope, next.name);
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
  // Taken = another skill in this scope holds the name. Keeping your OWN
  // name is not a collision — that's just an ordinary save. A bundled row
  // (view mode) never authors anything — no name is judged.
  const nameTaken =
    selection !== null &&
    selection.mode !== "view" &&
    !(selection.mode === "edit" && selection.name === form.name) &&
    skillAt(selection.scope, form.name) !== undefined;
  // The name is judged only where it is being AUTHORED — a create, or an edit
  // that changes it. An INHERITED name is not the editor's to refuse: the
  // library deliberately skips this rule on an update for the same reason, so a
  // hand-made `My_Skill` (which the Rust side stores and lists happily) stays
  // editable. Judging it here too made that skill openable and unsavable, with
  // a kebab-case complaint under a name the user was not editing — one rule,
  // two doors, opposite answers.
  const authoringName =
    selection !== null &&
    selection.mode !== "view" &&
    (selection.mode === "create" || selection.name !== form.name);
  // ONE verdict, like the description's, rendered by the gate AND the hint
  // below. Derived separately they drifted: an emptied Name field disabled Save
  // while the message stayed hidden, because "empty" counted as invalid at the
  // gate and as "nothing typed yet" at the message.
  const nameProblem = authoringName ? skillNameProblem(form.name) : null;
  // The GATE uses the verdict from the first render; the MESSAGE waits — but only
  // until the user has STARTED, not until they touch this particular field. Waiting
  // for the field itself meant filling the description first (the natural order on
  // a create form) left Create disabled with nothing at all on screen, which is the
  // failure the verdict exists to prevent. A pristine form still says nothing.
  const shownNameProblem = nameTouched || dirty || form.name !== "" ? nameProblem : null;
  // ONE verdict, rendered twice below: the Save gate and the hint under the
  // field. Derived separately they drifted apart the moment the rule grew — a
  // stricter gate with nothing on screen explaining the dead button. The rule
  // itself is the domain's, including why empty is refused (kimi silently drops
  // a skill whose description is empty, field-verified 0.27, so saving one would
  // "work" and never reach the agent).
  const descriptionProblem = skillDescriptionProblem(form.description);
  // `nameTaken` is a courtesy — it catches the collision before the round
  // trip and can name the skill. It is NOT the guard: it is derived from the
  // listed library, which is empty whenever the read failed, and the backend
  // refuses a create over an existing skill regardless. Disabling Create on a
  // library we could not read would trade a silent overwrite for a silently
  // dead button.
  const canSave =
    selection !== null &&
    dirty &&
    !vanished &&
    nameProblem === null &&
    !nameTaken &&
    descriptionProblem === null;

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
    // A view selection never reaches the write machine (openSkill routes
    // bundled rows there; this guard is the type-level backstop).
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

  // From the GROUPS, which pair each scope with the name it is shown under —
  // the one place that knows which workspace a scope belongs to. Re-deriving the
  // label from `activeWs` answered a different question ("what is the active
  // workspace called") and so stamped its name on any scope but its own: the
  // editor can outlive the switch that changed it, and the chip is the only
  // thing on screen saying which library a save lands in.
  const scopeLabel = (scope: SkillScope) =>
    groups.find((group) => sameSkillScope(group.scope, scope))?.label ?? "Workspace";

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
              if (skill.scope.kind === "bundled") {
                navigate({ mode: "view", name: skill.name });
                return;
              }
              navigate({ mode: "edit", scope: skill.scope, name: skill.name });
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
                scopeLabel={scopeLabel(selection.scope)}
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
