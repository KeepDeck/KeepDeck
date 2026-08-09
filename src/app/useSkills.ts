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
import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillDraft, SkillScope } from "../domain/skills";
import type { LibrarySkill } from "./skillsLibrary";
import { describeError, log } from "../ipc/log";
import { useAppRuntime } from "./runtimeContext";

export interface SkillsEditorState {
  /** The stored skills; `null` while the first load is in flight. */
  skills: LibrarySkill[] | null;
  /** The last failed operation, human-readable; cleared by the next success
   * or by `clearError` (navigation away from the failed skill). */
  error: string | null;
  clearError(): void;
  /**
   * `expectNew` picks between the library's two write verbs, which differ in
   * THREE ways, not one — say all of them, because a caller reading only the
   * collision half will be surprised by the other two:
   *   - a create refuses a name already taken (the guard that survives an
   *     unreadable library); an update refuses a name that is NOT there;
   *   - a create applies this build's naming rule; an update deliberately does
   *     not, so a hand-made `My_Skill` stays editable;
   *   - an update carries the stored file's other frontmatter over; a create
   *     writes exactly name, description and body.
   */
  save(scope: SkillScope, draft: SkillDraft, expectNew: boolean): Promise<boolean>;
  /** Move the skill's directory. Deliberately does NOT reload the list —
   * a rename is always followed by a save (whose refresh covers both), so
   * one user action costs one reload, not two. */
  rename(scope: SkillScope, from: string, to: string): Promise<boolean>;
  remove(scope: SkillScope, name: string): Promise<boolean>;
}

export function useSkillsLibrary(open: boolean): SkillsEditorState {
  const [skills, setSkills] = useState<LibrarySkill[] | null>(null);
  /** Tagged by WHERE it came from, because the two kinds have different
   * lifetimes: a read failure is answered by the next working read, an
   * operation's failure is the user's to read until they act again. One
   * untagged string meant a background re-read either wiped a save error or
   * left its own notice standing over a list it had just refreshed. */
  const [error, setError] = useState<{ from: "read" | "operation"; text: string } | null>(
    null,
  );
  const library = useAppRuntime().skills;
  /** Which library read owns the view — see `refresh`. */
  const reads = useRef(0);
  /** Whether a read has ever landed: "keep the stale list" has nothing to keep
   * before the first one. */
  const hasList = useRef(false);
  /** One of OUR writes is in flight, so its own notify is not worth a read. */
  const mutating = useRef(false);

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
   *
   * "keep" cannot keep what we do not have: while `skills` is still `null` a
   * failure MUST be reported whoever asked for the read, or a background re-read
   * that supersedes the dialog's first one and then fails leaves the editor on
   * "Loading…" forever with nothing saying why.
   */
  const refresh = useCallback(
    async (onFailure: "notify" | "keep"): Promise<boolean> => {
      // Reads are not ordered by the backend, and this hook now starts them from
      // three places plus a subscription, so a SUPERSEDED read must not land:
      // the dialog's slow first read completing after a create's re-read put the
      // pre-create library back on screen, hiding a skill that exists.
      const seq = ++reads.current;
      try {
        const all = await library.list();
        if (seq !== reads.current) return false;
        setSkills(all);
        hasList.current = true;
        // A working read answers the question a READ failure asked, so its notice
        // goes; an operation's failure is not this read's to clear — the user is
        // still reading why their save did not land.
        setError((prev) => (prev?.from === "read" ? null : prev));
        return true;
      } catch (e) {
        log.warn("web:skills", `skills_list failed (${onFailure}): ${describeError(e)}`);
        if (seq !== reads.current) return false;
        if (onFailure === "keep" && hasList.current) return false;
        setSkills([]);
        setError({ from: "read", text: `Could not read the skills library: ${describeError(e)}` });
        return false;
      }
    },
    [library],
  );

  useEffect(() => {
    if (!open) return;
    void refresh("notify");
  }, [open, refresh]);

  // A write through the OTHER door — an agent's skills.create/delete/rename —
  // changes the library under an open editor. Without this the nav kept listing
  // a skill that was gone and every save against it failed. "keep" because a
  // read that fails here belongs to no operation the user started.
  useEffect(() => {
    if (!open) return;
    return library.subscribe(() => {
      // Not while one of OUR OWN writes is in flight: that operation re-reads
      // when it settles, and answering its notify too would start a second full
      // library read per write, which is what "one user action, one reload"
      // above promises it does not do.
      if (!mutating.current) void refresh("keep");
    });
  }, [open, library, refresh]);

  /** Run a write, then re-read — and hold the subscription off while it runs, so
   * the write's own notify does not race its reload. */
  const mutate = useCallback(
    async (write: () => Promise<void>, failed: (e: unknown) => string) => {
      mutating.current = true;
      try {
        await write();
        // Cleared on a read that WORKED, after a write that worked: this is the
        // one place both are true, so it is the one place that clears an
        // operation's notice too.
        if (await refresh("keep")) setError(null);
        return true;
      } catch (e) {
        setError({ from: "operation", text: failed(e) });
        // The disk may still have moved under this action (a rename that
        // preceded the failed save): re-read so the list stays truthful, WITHOUT
        // clearing the error the user is reading.
        await refresh("keep");
        return false;
      } finally {
        mutating.current = false;
      }
    },
    [refresh],
  );

  const save = useCallback(
    (scope: SkillScope, draft: SkillDraft, expectNew: boolean) =>
      mutate(
        () => (expectNew ? library.create(scope, draft) : library.update(scope, draft)),
        (e) => `Save failed: ${describeError(e)}`,
      ),
    [library, mutate],
  );

  const rename = useCallback(
    async (scope: SkillScope, from: string, to: string) => {
      // NOT through `mutate`: a rename is half of one user action and the save
      // that follows owns the re-read, so one action still costs one reload. It
      // does hold the subscription off for the same reason `mutate` does.
      mutating.current = true;
      try {
        await library.rename(scope, from, to);
        return true;
      } catch (e) {
        setError({ from: "operation", text: `Rename failed: ${describeError(e)}` });
        return false;
      } finally {
        mutating.current = false;
      }
    },
    [library],
  );

  const clearError = useCallback(() => setError(null), []);

  const remove = useCallback(
    (scope: SkillScope, name: string) =>
      mutate(
        () => library.remove(scope, name),
        (e) => `Delete failed: ${describeError(e)}`,
      ),
    [library, mutate],
  );

  return { skills, error: error?.text ?? null, clearError, save, rename, remove };
}
