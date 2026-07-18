/**
 * The skills library as UI state: the stored list plus save/remove that keep
 * the spawn side honest — every successful write invalidates the staging
 * memo, so the next pane spawn re-stages the edited library. Loading happens
 * when the dialog opens (`open` flips true), not at boot: the library is
 * cold data until the user looks at it.
 */
import { useCallback, useEffect, useState } from "react";
import { composeSkillFile, type SkillDraft, type SkillScope } from "../domain/skills";
import {
  deleteSkill,
  listSkills,
  saveSkill,
  type StoredSkill,
} from "../ipc/skills";
import { describeError } from "../ipc/log";
import { invalidateSkillsStaging } from "./skillsStaging";

export interface SkillsLibrary {
  /** The stored skills; `null` while the first load is in flight. */
  skills: StoredSkill[] | null;
  /** The last failed operation, human-readable; cleared by the next success. */
  error: string | null;
  save(scope: SkillScope, draft: SkillDraft): Promise<boolean>;
  remove(scope: SkillScope, name: string): Promise<boolean>;
}

export function useSkillsLibrary(open: boolean): SkillsLibrary {
  const [skills, setSkills] = useState<StoredSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listSkills().then((all) => {
      if (alive) setSkills(all);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const refresh = useCallback(async () => {
    invalidateSkillsStaging();
    setSkills(await listSkills());
    setError(null);
  }, []);

  const save = useCallback(
    async (scope: SkillScope, draft: SkillDraft) => {
      try {
        await saveSkill(scope, draft.name, composeSkillFile(draft));
        await refresh();
        return true;
      } catch (e) {
        setError(`Save failed: ${describeError(e)}`);
        return false;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (scope: SkillScope, name: string) => {
      try {
        await deleteSkill(scope, name);
        await refresh();
        return true;
      } catch (e) {
        setError(`Delete failed: ${describeError(e)}`);
        return false;
      }
    },
    [refresh],
  );

  return { skills, error, save, remove };
}
