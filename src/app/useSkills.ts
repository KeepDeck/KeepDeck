/**
 * The skills library as UI state: the stored list plus save/remove that keep
 * the spawn side honest — every successful write reports the library as changed,
 * so the staged views it invalidates are re-staged at the next pane spawn.
 * Loading happens when the dialog opens (`open` flips true), not at boot: the
 * library is cold data until the user looks at it.
 *
 * The invalidation arrives as a callback rather than being reached for directly:
 * the staged views belong to the worktree manager, which owns them together with
 * the directories they are armed into.
 */
import { useCallback, useEffect, useState } from "react";
import { composeSkillFile, type SkillDraft, type SkillScope } from "../domain/skills";
import {
  deleteSkill,
  fetchSkills,
  renameSkill,
  saveSkill,
  type StoredSkill,
} from "../ipc/skills";
import { describeError, log } from "../ipc/log";

export interface SkillsLibrary {
  /** The stored skills; `null` while the first load is in flight. */
  skills: StoredSkill[] | null;
  /** The last failed operation, human-readable; cleared by the next success
   * or by `clearError` (navigation away from the failed skill). */
  error: string | null;
  clearError(): void;
  /** `expectNew` marks a CREATE, which the backend refuses if the name is
   * already taken — the guard that survives an unreadable library. */
  save(scope: SkillScope, draft: SkillDraft, expectNew: boolean): Promise<boolean>;
  /** Move the skill's directory. Deliberately does NOT reload the list —
   * a rename is always followed by a save (whose refresh covers both), so
   * one user action costs one reload, not two. */
  rename(scope: SkillScope, from: string, to: string): Promise<boolean>;
  remove(scope: SkillScope, name: string): Promise<boolean>;
}

export function useSkillsLibrary(
  open: boolean,
  onLibraryChanged: () => void,
): SkillsLibrary {
  const [skills, setSkills] = useState<StoredSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // Reading the raw form and handling the failure here, rather than taking
    // a wrapper's empty-list fallback: an empty library and one that could not
    // be read must not arrive as the same value.
    void fetchSkills().then(
      (all) => {
        if (!alive) return;
        setSkills(all);
      },
      (e: unknown) => {
        if (!alive) return;
        log.warn("web:skills", `skills_list failed: ${describeError(e)}`);
        // An empty list is what the editor can render, but it must not read as
        // "you have no skills": the error is the difference, and it is the
        // only thing on screen that says the library is unknown rather than
        // empty. The name-collision guard that matters lives in the backend,
        // which refuses a create over an existing skill whatever this list says.
        setSkills([]);
        setError(`Could not read the skills library: ${describeError(e)}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [open]);

  const refresh = useCallback(async () => {
    onLibraryChanged();
    try {
      setSkills(await fetchSkills());
      // Cleared only on a read that WORKED. Clearing regardless wiped the
      // "could not read the library" notice on the first successful save,
      // putting back the empty-looking library with nothing saying why —
      // which is the whole thing that notice exists to prevent.
      setError(null);
    } catch (e) {
      // The operation itself succeeded; only the re-read failed. Keep the
      // stale list — blanking it right after a successful write reads as
      // data loss (the same rule the failed-save path follows).
      log.warn("web:skills", `library reload failed; keeping the stale list: ${describeError(e)}`);
    }
  }, [onLibraryChanged]);

  const save = useCallback(
    async (scope: SkillScope, draft: SkillDraft, expectNew: boolean) => {
      try {
        await saveSkill(scope, draft.name, composeSkillFile(draft), expectNew);
        await refresh();
        return true;
      } catch (e) {
        setError(`Save failed: ${describeError(e)}`);
        // The disk may still have moved under this action (a rename that
        // preceded the failed save): reload so the list stays truthful,
        // WITHOUT clearing the error the user is reading. If the reload
        // itself fails (backend down), keep the stale list — stale beats
        // an empty library the user would read as data loss.
        try {
          setSkills(await fetchSkills());
        } catch {
          // keep whatever we last showed
        }
        return false;
      }
    },
    [refresh],
  );

  const rename = useCallback(async (scope: SkillScope, from: string, to: string) => {
    try {
      await renameSkill(scope, from, to);
      // The directory moved — staged views are stale NOW, even though the
      // list reload waits for the save that follows.
      onLibraryChanged();
      setError(null);
      return true;
    } catch (e) {
      setError(`Rename failed: ${describeError(e)}`);
      return false;
    }
  }, [onLibraryChanged]);

  const clearError = useCallback(() => setError(null), []);

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

  return { skills, error, clearError, save, rename, remove };
}
