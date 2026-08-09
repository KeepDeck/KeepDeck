/**
 * The skills library as UI STATE: the stored list, the last failure in words,
 * and a reload after each write. The library itself — validating a draft,
 * composing its SKILL.md, persisting it, and reporting the staged views stale —
 * belongs to `skillsLibrary`, reached through the runtime like every other
 * service this layer's hooks use.
 *
 * What stays here is exactly what a view needs and a command does not: an
 * in-flight/loaded distinction, human-readable error text, and the decision to
 * keep a stale list rather than blank it. Loading happens when the dialog opens
 * (`open` flips true), not at boot: the library is cold data until the user
 * looks at it.
 */
import { useCallback, useEffect, useState } from "react";
import type { SkillDraft, SkillScope } from "../domain/skills";
import type { StoredSkill } from "../ipc/skills";
import { describeError, log } from "../ipc/log";
import { useAppRuntime } from "./runtimeContext";

export interface SkillsEditorState {
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

export function useSkillsLibrary(open: boolean): SkillsEditorState {
  const [skills, setSkills] = useState<StoredSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const library = useAppRuntime().skills;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // Handling the failure here rather than taking an empty-list fallback: an
    // empty library and one that could not be read must not arrive as the same
    // value.
    void library.list().then(
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
  }, [open, library]);

  const reload = useCallback(async () => {
    try {
      setSkills(await library.list());
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
  }, [library]);

  const save = useCallback(
    async (scope: SkillScope, draft: SkillDraft, expectNew: boolean) => {
      try {
        await (expectNew ? library.create(scope, draft) : library.update(scope, draft));
        await reload();
        return true;
      } catch (e) {
        setError(`Save failed: ${describeError(e)}`);
        // The disk may still have moved under this action (a rename that
        // preceded the failed save): reload so the list stays truthful,
        // WITHOUT clearing the error the user is reading. If the reload
        // itself fails (backend down), keep the stale list — stale beats
        // an empty library the user would read as data loss.
        try {
          setSkills(await library.list());
        } catch {
          // keep whatever we last showed
        }
        return false;
      }
    },
    [library, reload],
  );

  const rename = useCallback(
    async (scope: SkillScope, from: string, to: string) => {
      try {
        await library.rename(scope, from, to);
        setError(null);
        return true;
      } catch (e) {
        setError(`Rename failed: ${describeError(e)}`);
        return false;
      }
    },
    [library],
  );

  const clearError = useCallback(() => setError(null), []);

  const remove = useCallback(
    async (scope: SkillScope, name: string) => {
      try {
        await library.remove(scope, name);
        await reload();
        return true;
      } catch (e) {
        setError(`Delete failed: ${describeError(e)}`);
        return false;
      }
    },
    [library, reload],
  );

  return { skills, error, clearError, save, rename, remove };
}
