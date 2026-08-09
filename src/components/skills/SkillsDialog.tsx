import { useMemo, useRef, useState } from "react";
import {
  normalizeSkillDescription,
  sameSkillScope,
  skillDescriptionProblem,
  skillDraftOf,
  skillNameProblem,
  type SkillDraft,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import { useSkillsLibrary } from "../../app/useSkills";
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

/** Which stored skill the editor shows, or the create form for a scope. */
type Selection =
  | { mode: "edit"; scope: SkillScope; name: string }
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
  const { skills, error, clearError, save, rename, remove } =
    useSkillsLibrary(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<SkillDraft>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  const submitting = useRef(false);
  /** A delete whose confirm has closed but whose IPC is still in flight — see
   * `submit`. */
  const deleting = useRef(false);
  /** The same two facts as STATE, because the buttons have to show it: a write
   * in flight must not just swallow the other write's click, or the user is left
   * pressing a button that does nothing. The refs stay for the synchronous
   * re-entry guard — state lands a render too late for that. */
  const [busy, setBusy] = useState(false);
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
    return built;
  }, [skills, activeWs]);

  /** The listed skill at (scope, name) — "which row IS this one" asked once,
   * where three sites had each spelled out the compound comparison. The library
   * asks the same question of the disk; if identity ever grows (case-insensitive
   * names, trimming), these are the two places that must move together. */
  const skillAt = (scope: SkillScope, name: string): LibrarySkill | undefined =>
    (skills ?? []).find(
      (s) => s.name === name && sameSkillScope(s.scope, scope),
    );

  const openSkill = (skill: LibrarySkill) => {
    // The same projection the library's `read` uses, WHOLE — so the editor and
    // every other surface see one skill, not two readings of one file. It
    // already applies "the directory name wins over the frontmatter's";
    // re-asserting `name` here was that rule stated a second time, in the one
    // place that would keep the old answer when it changed.
    setSelection({ mode: "edit", scope: skill.scope, name: skill.name });
    setForm(skillDraftOf(skill));
    setDirty(false);
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
      selection.name === next.name &&
      sameSkillScope(selection.scope, next.scope)
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

  const apply = (next: Selection | null, closing?: boolean) => {
    if (closing) {
      onClose();
      return;
    }
    // The user moved: any in-flight submit's terminal writes are stale now.
    navEpoch.current += 1;
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
  };

  // While a confirm is up, Escape belongs to IT (useEscape handlers stack);
  // the dialog's own close must not race a re-confirm underneath.
  useEscape(() => navigate(null, true), canClose && !confirm);

  const creating = selection?.mode === "create";
  // Taken = another skill in this scope holds the name. Keeping your OWN
  // name is not a collision — that's just an ordinary save.
  const nameTaken =
    selection !== null &&
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
    selection !== null && (selection.mode === "create" || selection.name !== form.name);
  // ONE verdict, like the description's, rendered by the gate AND the hint
  // below. Derived separately they drifted: an emptied Name field disabled Save
  // while the message stayed hidden, because "empty" counted as invalid at the
  // gate and as "nothing typed yet" at the message.
  const nameProblem = authoringName ? skillNameProblem(form.name) : null;
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
    const scope = selection.scope;
    // Staleness anchors: `nav` catches navigation during the awaits (the
    // completion must not yank the user back), `draftSource` catches typing
    // (newer keystrokes were NOT saved and must stay dirty).
    const nav = navEpoch.current;
    const draftSource = form;
    // An edited name moves the directory first (assets travel), then the
    // ordinary save lands the content under the new name.
    if (selection.mode === "edit" && form.name !== selection.name) {
      if (!(await rename(scope, selection.name, form.name))) {
        // A refusal that arrives after the user moved on belongs to the skill it
        // happened to, not to whatever is on screen now.
        if (navEpoch.current !== nav) clearError();
        return;
      }
      // From here the skill IS form.name on disk — the selection must say
      // so even if the content save below fails, or `nameTaken` would
      // treat our own new name as a collision and dead-end the editor.
      // (Skipped only if the user navigated away — the list reload after
      // the save carries the disk truth instead.)
      if (navEpoch.current === nav) {
        setSelection({ mode: "edit", scope, name: form.name });
      }
    }
    // A rename above has already moved the directory, so what lands now is an
    // overwrite of a skill that exists — only an untouched create is new.
    const expectNew = selection.mode === "create";
    const saved = await save(scope, draftSource, expectNew);
    if (navEpoch.current !== nav) {
      // Same as above: the outcome belongs to a skill the user has left.
      if (!saved) clearError();
      return;
    }
    if (saved) {
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
    if (!confirm) void submit();
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
            loading={skills === null}
            isActive={(skill) =>
              selection?.mode === "edit" &&
              selection.name === skill.name &&
              sameSkillScope(selection.scope, skill.scope)
            }
            onOpen={(skill) =>
              navigate({ mode: "edit", scope: skill.scope, name: skill.name })
            }
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
                validation={{ nameProblem, nameTaken, descriptionProblem }}
                canSave={canSave}
                error={error}
                onField={(key, value) => {
                  // The description is one YAML line by contract (see
                  // skillDescriptionProblem); its textarea wraps for
                  // reading, so a multi-line paste folds to spaces here
                  // instead of tripping validation.
                  const next =
                    key === "description" ? normalizeSkillDescription(value) : value;
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
            // Against the SAME epoch every other completion checks. Without it a
            // delete resolving after the user opened another skill ran apply(),
            // which clears the form — discarding that skill's unsaved edits with
            // no discard confirm, the one thing navigate() exists to prevent.
            const nav = navEpoch.current;
            const target = confirm;
            deleting.current = true;
            setBusy(true);
            void remove(target.scope, target.name)
              .then((ok) => {
                if (ok && navEpoch.current === nav) apply(null);
              })
              .finally(() => {
                deleting.current = false;
                setBusy(false);
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
