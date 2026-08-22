import { useEffect, useRef } from "react";
import { SKILL_NAME_RULE, type SkillDraft } from "../../domain/skills";
import { DestructiveButton } from "../../ui/DestructiveButton";
import { Chip } from "../../ui/Chip";

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
  /** A write is in flight. Both buttons go quiet — a delete racing a save can
   * re-create the skill the user just confirmed deleting, and the guard has to
   * be visible rather than silently swallowing the click. */
  busy: boolean;
  error: string | null;
  onField(key: "name" | "description" | "body", value: string): void;
  onSubmit(): void;
  onDelete(): void;
}

/** The editor panel — deliberately a CONTROLLED form (not an autonomous
 * SettingsDialog-style section): the dialog's state machine owns every
 * decision; this component only renders it. */
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
    <>
      {readOnlyNotice && (
        <p className="skills__readonly-note">{readOnlyNotice}</p>
      )}
      <div className="skills__editor-head">
        <h3 className="skills__editor-title">
          {creating ? "New skill" : savedName}
          {!readOnly && dirty && (
            <span
              className="skills__dirty"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
        </h3>
        <Chip size="inline" className="skills__scope" label={scopeLabel} />
      </div>

      <div className="skills__meta">
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
          className="form__input skills__desc"
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
        {readOnlyHint && (
          <p className="skills__readonly-hint">{readOnlyHint}</p>
        )}
        {validation.descriptionProblem === "empty" && (
          <div className="skills__hint">
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

      <label className="form__label skills__body-label" htmlFor="skill-body">
        Instructions · Markdown
      </label>
      <textarea
        id="skill-body"
        className="skills__text"
        value={form.body}
        onChange={(e) => {
          if (!readOnly) onField("body", e.target.value);
        }}
        readOnly={readOnly}
        aria-readonly={readOnly}
        placeholder="What the agent reads when the skill triggers"
        spellCheck={false}
      />

      {!readOnly && validation.vanished && (
        <div className="form__error">
          This skill was removed or renamed elsewhere. Copy anything you want to
          keep — saving it here would recreate a skill someone deleted.
        </div>
      )}
      {/* Backend text, not authored copy — selectable so it can be copied into
          a bug report, unlike the fixed guidance in the fields above. */}
      {!readOnly && error && (
        <div className="form__error kd-selectable">{error}</div>
      )}
      {!readOnly && (
        <div className="skills__actions">
          {!creating && (
            <DestructiveButton onClick={onDelete} disabled={busy}>
              Delete
            </DestructiveButton>
          )}
          <span className="skills__actions-gap" />
          <button
            type="button"
            className="form__create"
            onClick={onSubmit}
            disabled={!canSave || busy}
          >
            {creating ? "Create" : "Save"}
          </button>
        </div>
      )}
    </>
  );
}
