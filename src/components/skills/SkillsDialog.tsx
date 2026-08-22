import { sameSkillRef } from "../../domain/skills";
import { SkillViewer } from "./SkillViewer";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { SkillEditor } from "./SkillEditor";
import { SkillsNav } from "./SkillsNav";
import { labelForScope } from "./skillGroups";
import { useSkillsEditor } from "./useSkillsEditor";

interface SkillsDialogProps {
  /** The active workspace, hosting the "This workspace" scope; `null` (no
   * workspace yet) leaves only the global scope. */
  activeWs: { id: string; name: string } | null;
  onClose(): void;
  /** False while a transaction is stacked over this dialog: `onClose` refuses
   * then, so Escape must not be claimed either. Distinct from this dialog's
   * OWN confirm, which the machine tracks itself. */
  canClose?: boolean;
}

/**
 * The shared-skills manager — a full-screen editor over the library ([skills]):
 * one SKILL.md authored here reaches every CLI at its next spawn.
 *
 * The SHELL: chrome, the placeholder, and the panels. Every transition —
 * selection, dirty tracking, the confirm flows, submit orchestration —
 * belongs to `useSkillsEditor`, and the panels stay CONTROLLED on purpose
 * (unlike SettingsDialog's autonomous sections): the machine owns every
 * transition, so this file decides nothing. Destructive steps confirm
 * in-app, per the no-system-dialogs rule.
 */
export function SkillsDialog({
  activeWs,
  onClose,
  canClose = true,
}: SkillsDialogProps) {
  const editor = useSkillsEditor({ activeWs, onClose, canClose });
  const {
    skills,
    error,
    listTrusted,
    groups,
    selection,
    form,
    verdicts,
    busy,
    deletingNow,
    confirm,
  } = editor;

  return (
    <ModalOverlay>
      <div className="form skills" role="dialog" aria-modal="true" aria-label="Skills">
        <div className="settings__head">
          <h2 className="form__title settings__title">Skills</h2>
          <CloseButton
            label="Close skills"
            onClick={() => editor.navigate(null, true)}
          />
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
            onOpen={(skill) => editor.navigate(editor.selectionFor(skill))}
            onCreate={(scope) => editor.navigate({ mode: "create", scope })}
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
                // `selection` changed — which the submit does mid-flight, on
                // create→edit and again on a rename — tearing down the fields the
                // user was typing into and dropping focus, caret and scroll. The
                // create form's focus is the editor's own business now.
                creating={editor.creating}
                savedName={selection.mode === "edit" ? selection.name : null}
                scopeLabel={labelForScope(groups, selection.scope)}
                form={form}
                dirty={editor.dirty}
                validation={{
                  nameProblem: verdicts.shownNameProblem,
                  nameTaken: verdicts.nameTaken,
                  descriptionProblem: verdicts.descriptionProblem,
                  vanished: verdicts.vanished,
                }}
                canSave={verdicts.canSave}
                error={error}
                onField={editor.onField}
                onSubmit={() => void editor.submit()}
                busy={busy}
                onDelete={editor.requestDelete}
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
          onConfirm={editor.confirmDelete}
          onCancel={editor.cancelConfirm}
        />
      )}
      {confirm?.kind === "discard" && (
        <ConfirmDialog
          title="Discard changes"
          message="This skill has unsaved changes"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={editor.confirmDiscard}
          onCancel={editor.cancelConfirm}
        />
      )}
    </ModalOverlay>
  );
}
