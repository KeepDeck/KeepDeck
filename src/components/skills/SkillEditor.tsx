import { useEffect, useRef } from "react";
import { SKILL_NAME_RULE, type SkillDraft } from "../../domain/skills";
import { EditorFrame } from "../library/EditorFrame";

/** What the dialog decided about the current draft — the editor renders
 * verdicts, it never re-derives them. */
export interface SkillValidation {
  /** The domain's name verdict, or `null` when the name is not this editor's to
   * judge (an inherited one). */
  nameProblem: "empty" | "invalid" | null;
  nameTaken: boolean;
  /** The domain's description verdict, rendered by both arms — the gate refuses
   * either, so a message for only one leaves a dead button unexplained. */
  descriptionProblem: "empty" | "multiline" | null;
  /** The skill was removed or renamed elsewhere while it was open. */
  vanished: boolean;
}

interface SkillEditorProps {
  /** Create mode shows "New skill" and enables Create; edit mode titles the
   * editor with the saved name and offers Delete. */
  creating: boolean;
  /** The saved name an edit is anchored to (the header title). */
  savedName: string | null;
  scopeLabel: string;
  /** Bundled skills use this same panel without exposing any write controls. */
  readOnly?: boolean;
  /** Optional bundled-skill guidance, kept outside the authored fields. */
  readOnlyNotice?: string;
  readOnlyHint?: string;
  /** The library's own draft shape, not a second declaration of it: what the
   * form holds is exactly what a write takes. `extraFrontmatter` rides along
   * unread — the library preserves whatever the stored file has, so nothing here
   * can author it. */
  form: SkillDraft;
  dirty: boolean;
  validation: SkillValidation;
  canSave: boolean;
  busy: boolean;
  error: string | null;
  onField(key: "name" | "description" | "body", value: string): void;
  onSubmit(): void;
  onDelete(): void;
}

/** The skill editor's fields inside the shared frame — deliberately a
 * CONTROLLED form: the dialog's state machine owns every decision; this
 * component only renders it. */
export function SkillEditor({
  creating,
  savedName,
  scopeLabel,
  readOnly = false,
  readOnlyNotice,
  readOnlyHint,
  form,
  dirty,
  validation,
  canSave,
  busy,
  error,
  onField,
  onSubmit,
  onDelete,
}: SkillEditorProps) {
  const nameField = useRef<HTMLInputElement>(null);
  // Focus on ENTERING create mode, rather than `autoFocus`, which only fires at
  // mount: this component is deliberately not remounted per selection (a remount
  // mid-submit threw away the caret), so mount is no longer when the create form
  // appears.
  useEffect(() => {
    if (creating) nameField.current?.focus();
  }, [creating]);

  return (
    <EditorFrame
      creating={creating}
      newTitle="New skill"
      savedName={savedName}
      scopeLabel={scopeLabel}
      readOnly={readOnly}
      readOnlyNotice={readOnlyNotice}
      dirty={dirty}
      vanishedMessage={
        validation.vanished
          ? "This skill was removed or renamed elsewhere. Copy anything you want to keep — saving it here would recreate a skill someone deleted."
          : null
      }
      error={error}
      canSave={canSave}
      busy={busy}
      onSubmit={onSubmit}
      onDelete={onDelete}
    >
      <div className="library__meta">
        <label className="form__label" htmlFor="skill-name">
          Name
        </label>
        <input
          id="skill-name"
          className="form__input"
          ref={nameField}
          value={form.name}
          onChange={(e) => {
            if (!readOnly) onField("name", e.target.value);
          }}
          readOnly={readOnly}
          aria-readonly={readOnly}
          placeholder="kebab-case-name"
          spellCheck={false}
        />
        {/* Both arms of the verdict say something. "empty" used to say nothing,
            so clearing the field left a dead Save button unexplained. */}
        {validation.nameProblem === "empty" && (
          <div className="form__error">A skill needs a name</div>
        )}
        {validation.nameProblem === "invalid" && (
          <div className="form__error">{`Use ${SKILL_NAME_RULE}`}</div>
        )}
        {validation.nameTaken && (
          <div className="form__error">
            A skill with this name already exists in this scope
          </div>
        )}

        <label className="form__label" htmlFor="skill-description">
          Description
        </label>
        {/* A wrapping textarea so long descriptions read whole, but the
            VALUE stays one line (frontmatter contract): Enter is inert
            here and the dialog folds pasted newlines to spaces. */}
        <textarea
          id="skill-description"
          className="form__input library__desc"
          rows={3}
          value={form.description}
          onChange={(e) => {
            if (!readOnly) onField("description", e.target.value);
          }}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="When should an agent reach for this skill"
          spellCheck={false}
        />
        {readOnlyHint && <p className="library__readonly-hint">{readOnlyHint}</p>}
        {validation.descriptionProblem === "empty" && (
          <div className="library__hint">
            Required — agents pick skills by description, and some silently
            drop a skill without one
          </div>
        )}
        {/* Both arms again: the gate refuses "multiline" too, and with only the
            empty arm rendered that would be a dead Save with nothing said. */}
        {validation.descriptionProblem === "multiline" && (
          <div className="form__error">A description has to fit on one line</div>
        )}
      </div>

      <label className="form__label library__body-label" htmlFor="skill-body">
        Instructions · Markdown
      </label>
      <textarea
        id="skill-body"
        className="library__text"
        value={form.body}
        onChange={(e) => {
          if (!readOnly) onField("body", e.target.value);
        }}
        readOnly={readOnly}
        aria-readonly={readOnly}
        placeholder="What the agent reads when the skill triggers"
        spellCheck={false}
      />
    </EditorFrame>
  );
}
