import { useMemo, useState } from "react";
import {
  isValidSkillDescription,
  isValidSkillName,
  parseSkillFile,
  type SkillDraft,
  type SkillScope,
} from "../../domain/skills";
import type { StoredSkill } from "../../ipc/skills";
import { useSkillsLibrary } from "../../app/useSkills";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DestructiveButton } from "../../ui/DestructiveButton";
import { CloseIcon } from "../../ui/icons";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";

interface SkillsDialogProps {
  /** The active workspace, hosting the "This workspace" scope; `null` (no
   * workspace yet) leaves only the global scope. */
  activeWs: { id: string; name: string } | null;
  onClose(): void;
}

/** Which stored skill the editor shows, or the create form for a scope. */
type Selection =
  | { mode: "edit"; scope: SkillScope; name: string }
  | { mode: "create"; scope: SkillScope };

/** The editable fields; `extraFrontmatter` rides along invisibly so saving
 * an edited skill keeps hand-added keys. */
interface FormState {
  name: string;
  description: string;
  body: string;
  extraFrontmatter: string[];
}

const EMPTY_FORM: FormState = { name: "", description: "", body: "", extraFrontmatter: [] };

const sameScope = (a: SkillScope, b: SkillScope) =>
  a.kind === b.kind && (a.kind !== "workspace" || b.kind !== "workspace" || a.wsId === b.wsId);

const scopeOf = (skill: StoredSkill): SkillScope =>
  skill.scope === "global"
    ? { kind: "global" }
    : { kind: "workspace", wsId: skill.wsId ?? "" };

/**
 * The shared-skills manager — a full-screen editor over the library ([skills]):
 * one SKILL.md authored here reaches every CLI at its next spawn. Left: the
 * library, grouped Global / This workspace. Right: the editor. Destructive
 * steps (delete, discarding edits) confirm in-app, per the no-system-dialogs
 * rule.
 */
export function SkillsDialog({ activeWs, onClose }: SkillsDialogProps) {
  const { skills, error, save, remove } = useSkillsLibrary(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  // A destructive step awaiting confirmation.
  const [confirm, setConfirm] = useState<
    | { kind: "delete"; scope: SkillScope; name: string }
    | { kind: "discard"; next: Selection | null; closing?: boolean }
    | null
  >(null);

  const globalSkills = useMemo(
    () => (skills ?? []).filter((s) => s.scope === "global"),
    [skills],
  );
  const wsSkills = useMemo(
    () => (skills ?? []).filter((s) => s.scope === "workspace" && s.wsId === activeWs?.id),
    [skills, activeWs],
  );

  const openSkill = (skill: StoredSkill) => {
    const parsed = parseSkillFile(skill.content);
    setSelection({ mode: "edit", scope: scopeOf(skill), name: skill.name });
    setForm({
      name: skill.name,
      description: parsed.description,
      body: parsed.body,
      extraFrontmatter: parsed.extraFrontmatter,
    });
    setDirty(false);
  };

  /** Move the editor elsewhere, guarding unsaved edits behind a confirm. */
  const navigate = (next: Selection | null, closing?: boolean) => {
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
    if (next?.mode === "edit") {
      const skill = (skills ?? []).find(
        (s) => s.name === next.name && sameScope(scopeOf(s), next.scope),
      );
      if (skill) {
        openSkill(skill);
        return;
      }
    }
    setSelection(next);
    setForm(EMPTY_FORM);
    setDirty(false);
  };

  // While a confirm is up, Escape belongs to IT (useEscape handlers stack);
  // the dialog's own close must not race a re-confirm underneath.
  useEscape(() => {
    if (!confirm) navigate(null, true);
  });

  const creating = selection?.mode === "create";
  const nameTaken =
    creating &&
    (skills ?? []).some(
      (s) => s.name === form.name && sameScope(scopeOf(s), selection.scope),
    );
  const nameOk = isValidSkillName(form.name);
  const canSave =
    selection !== null &&
    dirty &&
    nameOk &&
    !nameTaken &&
    isValidSkillDescription(form.description);

  const submit = async () => {
    if (!selection || !canSave) return;
    const draft: SkillDraft = { ...form };
    if (await save(selection.scope, draft)) {
      setSelection({ mode: "edit", scope: selection.scope, name: form.name });
      setDirty(false);
    }
  };

  const field =
    (key: "name" | "description" | "body") =>
    (value: string) => {
      setForm((f) => ({ ...f, [key]: value }));
      setDirty(true);
    };

  const item = (skill: StoredSkill) => {
    const active =
      selection?.mode === "edit" &&
      selection.name === skill.name &&
      sameScope(selection.scope, scopeOf(skill));
    return (
      <button
        key={`${skill.scope}:${skill.wsId ?? ""}:${skill.name}`}
        type="button"
        className={`settings__nav-item${active ? " settings__nav-item--active" : ""}`}
        aria-current={active || undefined}
        onClick={() => navigate({ mode: "edit", scope: scopeOf(skill), name: skill.name })}
      >
        {skill.name}
      </button>
    );
  };

  const group = (label: string, scope: SkillScope, items: StoredSkill[]) => (
    <div className="skills__group">
      <div className="skills__group-head">
        <span>{label}</span>
        <button
          type="button"
          className="skills__new"
          onClick={() => navigate({ mode: "create", scope })}
          title={`New ${scope.kind === "global" ? "global" : "workspace"} skill`}
        >
          + New
        </button>
      </div>
      {items.map(item)}
      {items.length === 0 && <div className="skills__empty-group">No skills yet</div>}
    </div>
  );

  return (
    <ModalOverlay>
      <div className="form skills" role="dialog" aria-modal="true" aria-label="Skills">
        <div className="settings__head">
          <h2 className="form__title settings__title">Skills</h2>
          <button
            type="button"
            className="settings__close"
            onClick={() => navigate(null, true)}
            title="Close skills"
            aria-label="Close skills"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="skills__body">
          <nav className="skills__nav" aria-label="Skills library">
            {group("Global", { kind: "global" }, globalSkills)}
            {activeWs &&
              group(
                activeWs.name,
                { kind: "workspace", wsId: activeWs.id },
                wsSkills,
              )}
          </nav>

          <section className="skills__editor">
            {selection === null ? (
              <div className="skills__placeholder">
                {skills === null
                  ? "Loading…"
                  : "Pick a skill on the left, or create one — it reaches every agent's next session"}
              </div>
            ) : (
              <>
                <label className="form__label" htmlFor="skill-name">
                  Name
                </label>
                <input
                  id="skill-name"
                  className="form__input"
                  value={form.name}
                  onChange={(e) => field("name")(e.target.value)}
                  disabled={!creating}
                  placeholder="kebab-case-name"
                  spellCheck={false}
                  autoFocus={creating}
                />
                {creating && form.name !== "" && !nameOk && (
                  <div className="form__error">
                    Lowercase letters, digits and hyphens only
                  </div>
                )}
                {nameTaken && (
                  <div className="form__error">
                    A skill with this name already exists in this scope
                  </div>
                )}

                <label className="form__label" htmlFor="skill-description">
                  Description
                </label>
                <input
                  id="skill-description"
                  className="form__input"
                  value={form.description}
                  onChange={(e) => field("description")(e.target.value)}
                  placeholder="When should an agent reach for this skill"
                  spellCheck={false}
                />

                <label className="form__label" htmlFor="skill-body">
                  Instructions
                </label>
                <textarea
                  id="skill-body"
                  className="skills__text"
                  value={form.body}
                  onChange={(e) => field("body")(e.target.value)}
                  placeholder="Markdown the agent reads when the skill triggers"
                  spellCheck={false}
                />

                {error && <div className="form__error">{error}</div>}
                <div className="skills__actions">
                  {!creating && selection.mode === "edit" && (
                    <DestructiveButton
                      onClick={() =>
                        setConfirm({
                          kind: "delete",
                          scope: selection.scope,
                          name: selection.name,
                        })
                      }
                    >
                      Delete
                    </DestructiveButton>
                  )}
                  <span className="skills__actions-gap" />
                  <button
                    type="button"
                    className="form__create"
                    onClick={() => void submit()}
                    disabled={!canSave}
                  >
                    {creating ? "Create" : "Save"}
                  </button>
                </div>
              </>
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
            void remove(confirm.scope, confirm.name).then((ok) => {
              if (ok) apply(null);
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
