/**
 * The skills library as UI STATE — the generic library binding
 * ([`useLibraryState`]) configured for skills: which owner, how a row is
 * matched, and how the library is named in a notice. Everything the hook
 * owns (in-flight vs loaded, the error in words, the reload choreography) is
 * the generic hook's; this module only says which library.
 */
import { sameSkillRef, type SkillDraft, type SkillScope } from "../domain/skills";
import type { LibrarySkill } from "./skillsLibrary";
import { useAppRuntime } from "./runtimeContext";
import { useLibraryState, type LibraryState } from "./useLibraryState";

/** The generic state under the skills vocabulary: the rows are `skills`. */
export interface SkillsEditorState
  extends Omit<LibraryState<SkillScope, LibrarySkill, SkillDraft>, "rows"> {
  /** The stored skills; `null` while the first load is in flight. */
  skills: LibrarySkill[] | null;
}

export function useSkillsLibrary(open: boolean): SkillsEditorState {
  const { rows, ...state } = useLibraryState<SkillScope, LibrarySkill, SkillDraft>(
    useAppRuntime().skills,
    open,
    {
      sameRef: sameSkillRef,
      noun: "skills",
      logTag: "web:skills",
    },
  );
  return { skills: rows, ...state };
}
