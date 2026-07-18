import { useMemo, useRef, useState } from "react";
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
import { CloseIcon } from "../../ui/icons";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useSaveShortcut } from "../../ui/useSaveShortcut";
import { SkillEditor, type SkillFormState } from "./SkillEditor";
import { SkillsNav, type SkillsNavGroup } from "./SkillsNav";

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

const EMPTY_FORM: SkillFormState = {
  name: "",
  description: "",
  body: "",
  extraFrontmatter: [],
};

const sameScope = (a: SkillScope, b: SkillScope) =>
  a.kind === b.kind && (a.kind !== "workspace" || b.kind !== "workspace" || a.wsId === b.wsId);

const scopeOf = (skill: StoredSkill): SkillScope =>
  skill.scope === "global"
    ? { kind: "global" }
    : { kind: "workspace", wsId: skill.wsId ?? "" };

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
export function SkillsDialog({ activeWs, onClose }: SkillsDialogProps) {
  const { skills, error, clearError, save, rename, remove } = useSkillsLibrary(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<SkillFormState>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  const submitting = useRef(false);
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
        items: all.filter((s) => s.scope === "global"),
      },
    ];
    if (activeWs) {
      built.push({
        label: activeWs.name,
        scope: { kind: "workspace", wsId: activeWs.id },
        items: all.filter((s) => s.scope === "workspace" && s.wsId === activeWs.id),
      });
    }
    return built;
  }, [skills, activeWs]);

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
    // A stale error belongs to the skill it happened on, not to wherever
    // the user navigates next.
    clearError();
    if (next?.mode === "edit") {
      const target = next;
      const skill = (skills ?? []).find(
        (s) => s.name === target.name && sameScope(scopeOf(s), target.scope),
      );
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
  useEscape(() => {
    if (!confirm) navigate(null, true);
  });

  const creating = selection?.mode === "create";
  // Taken = another skill in this scope holds the name. Keeping your OWN
  // name is not a collision — that's just an ordinary save.
  const nameTaken =
    selection !== null &&
    !(selection.mode === "edit" && selection.name === form.name) &&
    (skills ?? []).some(
      (s) => s.name === form.name && sameScope(scopeOf(s), selection.scope),
    );
  const nameOk = isValidSkillName(form.name);
  // The spec makes description REQUIRED, and it's not pedantry: kimi
  // silently drops a skill whose description is empty (field-verified 0.27),
  // so saving one would "work" and then never reach the agent.
  const descriptionOk =
    form.description.trim() !== "" && isValidSkillDescription(form.description);
  const canSave =
    selection !== null && dirty && nameOk && !nameTaken && descriptionOk;

  const submit = async () => {
    // The rename half is not idempotent: a double ⌘S entering twice would
    // replay rename(old→new) after the first one consumed "old" and paint
    // a spurious "Rename failed" over a rename that worked.
    if (submitting.current || !selection || !canSave) return;
    submitting.current = true;
    try {
      await performSubmit(selection);
    } finally {
      submitting.current = false;
    }
  };

  const performSubmit = async (selection: Selection) => {
    const scope = selection.scope;
    // An edited name moves the directory first (assets travel), then the
    // ordinary save lands the content under the new name.
    if (selection.mode === "edit" && form.name !== selection.name) {
      if (!(await rename(scope, selection.name, form.name))) return;
      // From here the skill IS form.name on disk — the selection must say
      // so even if the content save below fails, or `nameTaken` would
      // treat our own new name as a collision and dead-end the editor.
      setSelection({ mode: "edit", scope, name: form.name });
    }
    const draft: SkillDraft = { ...form };
    if (await save(scope, draft)) {
      setSelection({ mode: "edit", scope, name: form.name });
      setDirty(false);
    }
  };

  // ⌘S saves from anywhere in the dialog — the editor is a writing surface
  // and writers hit ⌘S by reflex. Like Escape above, it yields while a
  // confirm is up: saving underneath a delete/discard confirmation would
  // change the very state the user is deciding about.
  useSaveShortcut(() => {
    if (!confirm) void submit();
  });

  const scopeLabel = (scope: SkillScope) =>
    scope.kind === "global" ? "Global" : (activeWs?.name ?? "Workspace");

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
          <SkillsNav
            groups={groups}
            isActive={(skill) =>
              selection?.mode === "edit" &&
              selection.name === skill.name &&
              sameScope(selection.scope, scopeOf(skill))
            }
            onOpen={(skill) =>
              navigate({ mode: "edit", scope: scopeOf(skill), name: skill.name })
            }
            onCreate={(scope) => navigate({ mode: "create", scope })}
          />

          <section className="skills__editor">
            {selection === null ? (
              <div className="skills__placeholder">
                {skills === null ? (
                  "Loading…"
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
                creating={creating}
                savedName={selection.mode === "edit" ? selection.name : null}
                scopeLabel={scopeLabel(selection.scope)}
                form={form}
                dirty={dirty}
                validation={{
                  nameInvalid: form.name !== "" && !nameOk,
                  nameTaken,
                  descriptionMissing: form.description.trim() === "",
                }}
                canSave={canSave}
                error={error}
                onField={(key, value) => {
                  setForm((f) => ({ ...f, [key]: value }));
                  setDirty(true);
                }}
                onSubmit={() => void submit()}
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
