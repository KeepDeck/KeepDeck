import { SkillEditor } from "./SkillEditor";
import { SkillsNav } from "./SkillsNav";
import { BUNDLED_NOTICE } from "./bundledTier";
import { labelForScope } from "./skillGroups";
import { useSkillRefusals } from "../../app/useSkillRefusals";
import { useSkillsEditor } from "./useSkillsEditor";
import { LibraryDialog } from "../library/LibraryDialog";

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
 * The skills HALF of the shell: the nav under the skills copy, the editor's
 * fields, and the refusal notice. Every transition — selection, dirty
 * tracking, the confirm flows, submit orchestration — belongs to
 * `useSkillsEditor`; the chrome, the placeholder and the confirms are the
 * shared [`LibraryDialog`]'s. The panels stay CONTROLLED on purpose (unlike
 * SettingsDialog's autonomous sections): the machine owns every transition,
 * so this file decides nothing. Destructive steps confirm in-app, per the
 * no-system-dialogs rule.
 */
export function SkillsDialog({
  activeWs,
  onClose,
  canClose = true,
}: SkillsDialogProps) {
  const editor = useSkillsEditor({ activeWs, onClose, canClose });
  // Where a skill did NOT reach an agent, and why. Dismissless on
  // purpose: it is not news to acknowledge but a condition that is
  // true until the user moves their own file, and it disappears by
  // itself when they do.
  const refusals = useSkillRefusals();
  const { error, groups, selection, form, verdicts, busy } = editor;

  return (
    <LibraryDialog
      title="Skills"
      closeLabel="Close skills"
      noun="skill"
      placeholder={{
        title: "One skill, every agent",
        body: "Pick a skill on the left or create one — it reaches Claude Code, Kimi, OpenCode and Codex worktrees at their next session",
      }}
      machine={{ ...editor, rows: editor.skills }}
      banner={
        refusals.length > 0 && (
          <div className="library__refusals" role="status">
            <span className="library__refusals-title">
              Some directories kept their own <code>.agents</code>, so skills
              were not planted there:
            </span>
            <ul>
              {refusals.map((refusal) => (
                <li key={refusal.root} className="kd-selectable">
                  <code>{refusal.root}</code> — {refusal.reason}
                </li>
              ))}
            </ul>
          </div>
        )
      }
      nav={
        <SkillsNav
          groups={groups}
          emptyMeans={editor.emptyMeans}
          busy={editor.deletingNow}
          isActive={editor.isActive}
          onOpen={(skill) => editor.navigate(editor.selectionFor(skill))}
          onCreate={(scope) => editor.navigate({ mode: "create", scope })}
        />
      }
      editor={
        selection && (
          <SkillEditor
            // NOT keyed per selection. That remounted the editor whenever
            // `selection` changed — which the submit does mid-flight, on
            // create→edit and again on a rename — tearing down the fields the
            // user was typing into and dropping focus, caret and scroll. The
            // create form's focus is the editor's own business now.
            creating={editor.creating}
            savedName={selection.mode === "create" ? null : selection.name}
            // A view selection names a BUNDLED row, which carries no scope of
            // its own — the mode implies the tier.
            scopeLabel={labelForScope(
              groups,
              selection.mode === "view" ? { kind: "bundled" } : selection.scope,
            )}
            readOnly={verdicts.isView}
            readOnlyNotice={verdicts.isView ? BUNDLED_NOTICE : undefined}
            readOnlyHint={verdicts.isView ? editor.viewHint : undefined}
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
        )
      }
    />
  );
}
