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

  /**
   * THE read: every path that puts the library on screen comes through here, so
   * the failure LOG exists once and a path added later cannot lose it. Three
   * hand-written copies had drifted into three different failure policies, one
   * of them an empty `catch` that logged nothing on the one path that runs only
   * when something has already gone wrong.
   *
   * `onFailure` is all a caller decides. "notify": the list is UNKNOWN and the
   * user must see why — an empty list is what the editor can render, but it must
   * not read as "you have no skills". "keep": an operation already reported its
   * own outcome, so a stale list beats blanking one right after a write, which
   * reads as data loss. (The collision guard that matters is the backend's,
   * which refuses a create over an existing skill whatever this list says.)
   */
  const refresh = useCallback(
    async (
      onFailure: "notify" | "keep",
      /** Whether this read still owns the view. The dialog's first load hands
       * one in so a read from a previous `open` cannot land over a newer one. */
      live: () => boolean = () => true,
    ): Promise<boolean> => {
      try {
        const all = await library.list();
        if (!live()) return false;
        setSkills(all);
        return true;
      } catch (e) {
        log.warn("web:skills", `skills_list failed (${onFailure}): ${describeError(e)}`);
        if (!live() || onFailure === "keep") return false;
        setSkills([]);
        setError(`Could not read the skills library: ${describeError(e)}`);
        return false;
      }
    },
    [library],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void refresh("notify", () => alive);
    return () => {
      alive = false;
    };
  }, [open, refresh]);

  const reload = useCallback(async () => {
    // Cleared only on a read that WORKED. Clearing regardless wiped the "could
    // not read the library" notice on the first successful save, putting back
    // the empty-looking library with nothing saying why — which is the whole
    // thing that notice exists to prevent.
    if (await refresh("keep")) setError(null);
  }, [refresh]);

  const save = useCallback(
    async (scope: SkillScope, draft: SkillDraft, expectNew: boolean) => {
      try {
        await (expectNew ? library.create(scope, draft) : library.update(scope, draft));
        await reload();
        return true;
      } catch (e) {
        setError(`Save failed: ${describeError(e)}`);
        // The disk may still have moved under this action (a rename that
        // preceded the failed save): re-read so the list stays truthful,
        // WITHOUT clearing the error the user is reading — which is why this is
        // `refresh`, not `reload`.
        await refresh("keep");
        return false;
      }
    },
    [library, reload, refresh],
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
