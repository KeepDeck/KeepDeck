import { DestructiveButton } from "../../ui/DestructiveButton";

/** The editable fields; `extraFrontmatter` rides along invisibly so saving
 * an edited skill keeps hand-added keys. */
export interface SkillFormState {
  name: string;
  description: string;
  body: string;
  extraFrontmatter: string[];
}

/** What the dialog decided about the current draft — the editor renders
 * verdicts, it never re-derives them. */
export interface SkillValidation {
  nameInvalid: boolean;
  nameTaken: boolean;
  descriptionMissing: boolean;
}

interface SkillEditorProps {
  /** Create mode shows "New skill" and enables Create; edit mode titles the
   * editor with the saved name and offers Delete. */
  creating: boolean;
  /** The saved name an edit is anchored to (the header title). */
  savedName: string | null;
  scopeLabel: string;
  form: SkillFormState;
  dirty: boolean;
  validation: SkillValidation;
  canSave: boolean;
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
  form,
  dirty,
  validation,
  canSave,
  error,
  onField,
  onSubmit,
  onDelete,
}: SkillEditorProps) {
  return (
    <>
      <div className="skills__editor-head">
        <h3 className="skills__editor-title">
          {creating ? "New skill" : savedName}
          {dirty && (
            <span
              className="skills__dirty"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
        </h3>
        <span className="skills__scope">{scopeLabel}</span>
      </div>

      <div className="skills__meta">
        <label className="form__label" htmlFor="skill-name">
          Name
        </label>
        <input
          id="skill-name"
          className="form__input"
          value={form.name}
          onChange={(e) => onField("name", e.target.value)}
          placeholder="kebab-case-name"
          spellCheck={false}
          autoFocus={creating}
        />
        {validation.nameInvalid && (
          <div className="form__error">Lowercase letters, digits and hyphens only</div>
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
          onChange={(e) => onField("description", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="When should an agent reach for this skill"
          spellCheck={false}
        />
        {validation.descriptionMissing && (
          <div className="skills__hint">
            Required — agents pick skills by description, and some silently
            drop a skill without one
          </div>
        )}
      </div>

      <label className="form__label skills__body-label" htmlFor="skill-body">
        Instructions · Markdown
      </label>
      <textarea
        id="skill-body"
        className="skills__text"
        value={form.body}
        onChange={(e) => onField("body", e.target.value)}
        placeholder="What the agent reads when the skill triggers"
        spellCheck={false}
      />

      {error && <div className="form__error">{error}</div>}
      <div className="skills__actions">
        {!creating && <DestructiveButton onClick={onDelete}>Delete</DestructiveButton>}
        <span className="skills__actions-gap" />
        <button
          type="button"
          className="form__create"
          onClick={onSubmit}
          disabled={!canSave}
        >
          {creating ? "Create" : "Save"}
        </button>
      </div>
    </>
  );
}
