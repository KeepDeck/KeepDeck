/**
 * The skills editor: the generic library machine ([`useLibraryEditor`])
 * configured for skills — the draft IS the form, a bundled row opens the
 * read-only panel, a description folds onto one line — plus the two
 * derived facts only a skills shell needs: the nav's groups and the bundled
 * tier's unlock hint.
 */
import { useMemo } from "react";
import {
  normalizeSkillDescription,
  sameSkillRef,
  skillDraftOf,
  type SkillDraft,
  type SkillLibraryScope,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import { useSettings } from "../../app/useSettings";
import { useSkillsLibrary } from "../../app/useSkills";
import { useLibraryEditor, type LibraryConfirm } from "../library/useLibraryEditor";
import type { SkillsNavGroup } from "./SkillsNav";
import { bundledUnlockHint } from "./bundledTier";
import { buildSkillGroups, type GroupWorkspace } from "./skillGroups";
import { bundledRowAt, skillAt, skillFormVerdicts } from "./skillFormVerdicts";

const EMPTY_FORM: SkillDraft = {
  name: "",
  description: "",
  body: "",
  extraFrontmatter: [],
};

export type SkillsConfirm = LibraryConfirm<SkillLibraryScope>;

export interface SkillsEditorDeps {
  activeWs: GroupWorkspace | null;
  onClose(): void;
  canClose: boolean;
}

export function useSkillsEditor({ activeWs, onClose, canClose }: SkillsEditorDeps) {
  const { skills, ...state } = useSkillsLibrary(true);
  // The settings PORT, not the artifacts feature: the machine pulls one
  // boolean and hands it to the tier's own text. `null` is the unsettled
  // boot load and reads as ON — no hint on unknown.
  const settings = useSettings();
  const viewHint = bundledUnlockHint(settings === null || settings.artifacts);

  const editor = useLibraryEditor<
    SkillScope,
    SkillLibraryScope,
    LibrarySkill,
    SkillDraft,
    SkillDraft,
    ReturnType<typeof skillFormVerdicts>
  >({
    state: { rows: skills, ...state },
    emptyForm: EMPTY_FORM,
    // The same projection the library's `read` uses, WHOLE — so the editor
    // and every other surface see one skill, not two readings of one file.
    formOf: skillDraftOf,
    draftOf: (form) => form,
    rowAt: skillAt,
    // The bundled tier is read-only: its rows open the view panel.
    writeScopeOf: (row) => (row.scope.kind === "bundled" ? null : row.scope),
    viewRowAt: bundledRowAt,
    sameRef: sameSkillRef,
    verdicts: ({ rows, ...world }) => skillFormVerdicts({ ...world, skills: rows }),
    /** The description is one YAML line by contract; its textarea wraps for
     * reading, so the domain's fold runs here rather than letting a
     * multi-line paste trip validation. */
    normalizeField: (key, value) =>
      key === "description" ? normalizeSkillDescription(value) : value,
    onClose,
    canClose,
  });

  const groups = useMemo<SkillsNavGroup[]>(
    () => buildSkillGroups(skills, activeWs),
    // On the FIELDS, not the object: `activeWs` is built as a fresh literal by
    // the caller on every App render, and depending on its identity rebuilt
    // these groups constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, activeWs?.id, activeWs?.name],
  );

  const { rows, ...machine } = editor;
  return {
    ...machine,
    skills: rows,
    groups,
    /** The bundled panel's unlock hint, or undefined when the feature is on
     * (or still unread). */
    viewHint,
  };
}
