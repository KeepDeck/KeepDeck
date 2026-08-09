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
import { sameSkillRef, type SkillDraft, type SkillScope } from "../domain/skills";
import type { LibrarySkill } from "./skillsLibrary";
import { describeError, log } from "../ipc/log";
import { useAppRuntime } from "./runtimeContext";

export interface SkillsEditorState {
  /** The stored skills; `null` while the first load is in flight. */
  skills: LibrarySkill[] | null;
  /** The last failed operation, human-readable; cleared by the next success
   * or by `clearError` (navigation away from the failed skill). */
  error: string | null;
  /** The list is `[]` because a read FAILED, not because the library is empty —
   * so a surface must not word it as "nothing here". */
  listUnknown: boolean;
  /** The last read LANDED, so absence from the list is a real answer. Anything
   * concluding "this skill is gone" has to check it: over a stale list that
   * conclusion is wrong, and acting on it discards the user's work. */
  listTrusted: boolean;
  clearError(): void;
  /**
   * `mode` NAMES the library verb rather than encoding it as a boolean the reader
   * has to decode. The two verbs differ in three ways, not one, and `true` said
   * none of them: a create refuses a name already taken (the storage's guard,
   * which survives a library we could not read) while an update refuses a name
   * that is NOT there; a create applies this build's naming rule while an update
   * deliberately does not, so a hand-made `My_Skill` stays editable; and an update
   * carries the stored file's other frontmatter over while a create writes exactly
   * name, description and body.
   */
  save(scope: SkillScope, draft: SkillDraft, mode: "create" | "update"): Promise<boolean>;
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
  /** The read generation current when a notify arrived while we held `mutating`;
   * `-1` for none. Compared against the generation afterwards to tell a notify our
   * own reload already covered from one it could not have. */
  const notifiedAtRead = useRef(-1);

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
        // A stale list is kept rather than blanked — but never SILENTLY. Saying
        // nothing let a delete whose reload failed leave the deleted skill listed
        // with three signals disagreeing; the list is stale either way, and the
        // user is the one who has to know it.
        const text = hasList.current
          ? `The skills list may be out of date: ${describeError(e)}`
          : `Could not read the skills library: ${describeError(e)}`;
        if (!hasList.current) setSkills([]);
        setError({ from: "read", text });
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
      // above promises it does not do. But REMEMBER it — the notify may be another
      // door's, and its change can land after our own read was already served, so
      // dropping it outright lost it for good.
      // Remember WHEN it arrived, not merely that it did. A notify that lands
      // before our own reload starts is covered by that reload — it reads the disk
      // after the other door's write already resolved. Only one that lands after
      // our read was issued can have been missed, and that is the one to replay.
      if (mutating.current) notifiedAtRead.current = reads.current;
      else void refresh("keep");
    });
  }, [open, library, refresh]);

  /** Run a write, then re-read — and hold the subscription off while it runs, so
   * the write's own notify does not race its reload. */
  const mutate = useCallback(
    async (
      write: () => Promise<void>,
      failed: (e: unknown) => string,
      /** A rename's re-read belongs to the save that follows it, so one user
       * action still costs one reload. Its FAILURE re-read is not optional. */
      { rereadOnSuccess = true }: { rereadOnSuccess?: boolean } = {},
    ) => {
      mutating.current = true;
      notifiedAtRead.current = -1;
      try {
        await write();
        // The WRITE landing is the fact this owns, so this is where an operation's
        // notice ends. Tying it to the following read meant a save that worked and
        // a re-read that did not left "Save failed" standing over a saved skill.
        setError((prev) => (prev?.from === "operation" ? null : prev));
        if (rereadOnSuccess) await refresh("keep");
        return true;
      } catch (e) {
        setError({ from: "operation", text: failed(e) });
        // The disk may still have moved under this action — a rename whose move
        // landed before its content write failed — so re-read either way, WITHOUT
        // clearing the error the user is reading.
        await refresh("keep");
        return false;
      } finally {
        mutating.current = false;
        // Replay only a notify our own read cannot have covered: one that arrived
        // at or after the generation of the newest read. A rename reads nothing on
        // purpose, so its notify is left to the save that follows — whose read
        // starts later and therefore sees it.
        const missed = notifiedAtRead.current === reads.current;
        notifiedAtRead.current = -1;
        if (missed && rereadOnSuccess) void refresh("keep");
      }
    },
    [refresh],
  );

  const save = useCallback(
    (scope: SkillScope, draft: SkillDraft, mode: "create" | "update") =>
      mutate(
        () => (mode === "create" ? library.create(scope, draft) : library.update(scope, draft)),
        (e) => `Save failed: ${describeError(e)}`,
      ),
    [library, mutate],
  );

  const rename = useCallback(
    (scope: SkillScope, from: string, to: string) =>
      // Through `mutate` like every other write. It used to be a hand-written
      // copy of four of `mutate`'s steps, and the one it skipped was the FAILURE
      // re-read — on the operation whose failure is likeliest to have moved the
      // disk already, so the nav and the open form kept pre-rename bytes and the
      // next save wrote from them.
      mutate(
        () => library.rename(scope, from, to),
        (e) => `Rename failed: ${describeError(e)}`,
        { rereadOnSuccess: false },
      ),
    [library, mutate],
  );

  const clearError = useCallback(() => setError(null), []);

  const remove = useCallback(
    (scope: SkillScope, name: string) =>
      mutate(
        async () => {
          await library.remove(scope, name);
          // Dropped from the list HERE, not left to the re-read. "Keep the stale
          // list" is a create/update argument — for a delete it shows the user the
          // thing they just removed, and if the re-read then fails they are looking
          // at a row whose editor answers "No skill …". This one fact we know.
          setSkills((rows) =>
            rows === null
              ? rows
              : rows.filter((row) => !sameSkillRef(row, { scope, name })),
          );
        },
        (e) => `Delete failed: ${describeError(e)}`,
      ),
    [library, mutate],
  );

  return {
    skills,
    error: error?.text ?? null,
    // The tag stays private — no view branches on where an error came from — but
    // TWO facts derived from it are a view's business, and only this hook can
    // answer them. An empty list from a failed read must not be rendered as
    // "nothing here"; and a list whose last read did not land must not be used to
    // conclude that a skill was deleted elsewhere.
    listUnknown: error?.from === "read" && !hasList.current,
    listTrusted: error?.from !== "read",
    clearError,
    save,
    rename,
    remove,
  };
}
