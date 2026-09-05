/**
 * A per-workspace library as UI STATE: the stored list, the last failure in
 * words, and a reload after each write. The library itself — validating a
 * draft, composing its file, persisting it, telling the spawn path — belongs
 * to the library's owner (`skillsLibrary`, `mcpLibrary`), reached through the
 * runtime like every other service this layer's hooks use.
 *
 * Generic over the item because two libraries share every rule here — an
 * in-flight/loaded distinction, human-readable error text, the decision to
 * keep a stale list rather than blank it, and the choreography between a
 * write's own reload and a notify from the OTHER door — and none of those
 * rules mentions what a skill or a server is. What differs is handed in as
 * [`LibraryStateConfig`]. Loading happens when the dialog opens (`open` flips
 * true), not at boot: a library is cold data until the user looks at it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, log } from "../ipc/log";

/** What the hook needs from a library's owner — the writes, the read, and
 * the notify that a write happened through any door. */
export interface LibraryStatePorts<Scope, Row, Draft> {
  list(): Promise<Row[]>;
  create(scope: Scope, draft: Draft): Promise<void>;
  update(scope: Scope, draft: Draft): Promise<void>;
  rename(scope: Scope, from: string, to: string): Promise<void>;
  remove(scope: Scope, name: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface LibraryStateConfig<Scope, Row> {
  /** Whether a stored row IS the item a reference names — for the one
   * optimistic edit this hook makes (dropping a deleted row). */
  sameRef(row: Row, ref: { scope: Scope; name: string }): boolean;
  /** How the library reads in a notice and a log line: "skills", "MCP servers". */
  noun: string;
  /** The log lane the library's reads report on. */
  logTag: `web:${string}`;
}

export interface LibraryState<Scope, Row, Draft> {
  /** The stored rows; `null` while the first load is in flight. */
  rows: Row[] | null;
  /** The last failed operation, human-readable; cleared by the next success
   * or by `clearError` (navigation away from the failed item). */
  error: string | null;
  /**
   * The last read LANDED, so what the list says is a real answer.
   *
   * ONE fact, serving both readers: a surface must not word an empty list as
   * "nothing here" when nobody managed to read the library, and nothing may
   * conclude "this item is gone" from a list whose last read failed — over a
   * stale list that conclusion is wrong, and acting on it discards the
   * user's work.
   */
  listTrusted: boolean;
  clearError(): void;
  /**
   * `mode` NAMES the library verb rather than encoding it as a boolean the
   * reader has to decode: a create refuses a name already taken (the storage's
   * guard, which survives a library we could not read) while an update refuses
   * a name that is NOT there; a create applies this build's naming rule while
   * an update deliberately does not, so a hand-made name stays editable.
   */
  save(scope: Scope, draft: Draft, mode: "create" | "update"): Promise<boolean>;
  /** Move the item. Deliberately does NOT reload the list — a rename is
   * always followed by a save (whose refresh covers both), so one user
   * action costs one reload, not two. */
  rename(scope: Scope, from: string, to: string): Promise<boolean>;
  remove(scope: Scope, name: string): Promise<boolean>;
}

export function useLibraryState<Scope, Row, Draft>(
  library: LibraryStatePorts<Scope, Row, Draft>,
  open: boolean,
  config: LibraryStateConfig<Scope, Row>,
): LibraryState<Scope, Row, Draft> {
  const { sameRef, noun, logTag } = config;
  const [rows, setRows] = useState<Row[] | null>(null);
  /** Tagged by WHERE it came from, because the two kinds have different
   * lifetimes: a read failure is answered by the next working read, an
   * operation's failure is the user's to read until they act again. One
   * untagged string meant a background re-read either wiped a save error or
   * left its own notice standing over a list it had just refreshed. */
  const [error, setError] = useState<{ from: "read" | "operation"; text: string } | null>(
    null,
  );
  /** Which library read owns the view — see `refresh`. */
  const reads = useRef(0);
  /** Whether a read has ever landed: "keep the stale list" has nothing to keep
   * before the first one. */
  const hasList = useRef(false);
  /**
   * Whether the LAST read failed — as state, and deliberately NOT derived from
   * the error: the view is allowed to clear that error, and whether a read
   * landed is a fact about the read with a lifetime of its own.
   */
  const [readFailed, setReadFailed] = useState(false);
  /** One of OUR writes is in flight, so its own notify is not worth a read. */
  const mutating = useRef(false);
  /** The read generation current when a notify arrived while we held
   * `mutating`; `-1` for none. Compared against the generation afterwards to
   * tell a notify our own reload already covered from one it could not have. */
  const notifiedAtRead = useRef(-1);

  /**
   * THE read: every path that puts the library on screen comes through here,
   * so the failure LOG exists once and a path added later cannot lose it.
   *
   * `onFailure` is all a caller decides. "notify": the list is UNKNOWN and the
   * user must see why. "keep": an operation already reported its own outcome,
   * so a stale list beats blanking one right after a write, which reads as
   * data loss. "keep" cannot keep what we do not have: while `rows` is still
   * `null` a failure MUST be reported whoever asked for the read.
   */
  const refresh = useCallback(
    async (onFailure: "notify" | "keep"): Promise<boolean> => {
      // Reads are not ordered by the backend, so a SUPERSEDED read must not
      // land: a slow first read completing after a create's re-read would put
      // the pre-create library back on screen.
      const seq = ++reads.current;
      try {
        const all = await library.list();
        if (seq !== reads.current) return false;
        setRows(all);
        hasList.current = true;
        setReadFailed(false);
        // A working read answers the question a READ failure asked; an
        // operation's failure is not this read's to clear.
        setError((prev) => (prev?.from === "read" ? null : prev));
        return true;
      } catch (e) {
        log.warn(logTag, `${noun} list failed (${onFailure}): ${describeError(e)}`);
        if (seq !== reads.current) return false;
        setReadFailed(true);
        // A stale list is kept rather than blanked — but never SILENTLY: the
        // list is stale either way, and the user is the one who has to know.
        const text = hasList.current
          ? `The ${noun} list may be out of date: ${describeError(e)}`
          : `Could not read the ${noun} library: ${describeError(e)}`;
        if (!hasList.current) setRows([]);
        // YIELDING to an operation's notice, which is newer and more specific.
        // `readFailed` above still drives the affordances.
        setError((prev) => (prev?.from === "operation" ? prev : { from: "read", text }));
        return false;
      }
    },
    [library, logTag, noun],
  );

  useEffect(() => {
    if (!open) return;
    void refresh("notify");
  }, [open, refresh]);

  // A write through the OTHER door — an agent's command — changes the library
  // under an open editor. "keep" because a read that fails here belongs to no
  // operation the user started.
  useEffect(() => {
    if (!open) return;
    return library.subscribe(() => {
      // Not while one of OUR OWN writes is in flight: that operation re-reads
      // when it settles. But REMEMBER when it arrived — only a notify that
      // lands after our read was issued can have been missed.
      if (mutating.current) notifiedAtRead.current = reads.current;
      else void refresh("keep");
    });
  }, [open, library, refresh]);

  /** Run a write, then re-read — and hold the subscription off while it runs,
   * so the write's own notify does not race its reload. */
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
        // The WRITE landing is the fact this owns, so this is where an
        // operation's notice ends.
        setError((prev) => (prev?.from === "operation" ? null : prev));
        if (rereadOnSuccess) await refresh("keep");
        return true;
      } catch (e) {
        setError({ from: "operation", text: failed(e) });
        // The disk may still have moved under this action, so re-read either
        // way, WITHOUT clearing the error the user is reading.
        await refresh("keep");
        return false;
      } finally {
        mutating.current = false;
        // Replay only a notify our own read cannot have covered.
        const missed = notifiedAtRead.current === reads.current;
        notifiedAtRead.current = -1;
        if (missed && rereadOnSuccess) void refresh("keep");
      }
    },
    [refresh],
  );

  const save = useCallback(
    (scope: Scope, draft: Draft, mode: "create" | "update") =>
      mutate(
        () => (mode === "create" ? library.create(scope, draft) : library.update(scope, draft)),
        (e) => `Save failed: ${describeError(e)}`,
      ),
    [library, mutate],
  );

  const rename = useCallback(
    (scope: Scope, from: string, to: string) =>
      mutate(
        () => library.rename(scope, from, to),
        (e) => `Rename failed: ${describeError(e)}`,
        { rereadOnSuccess: false },
      ),
    [library, mutate],
  );

  /** Drop the notice for the OPERATION the user has navigated away from. A
   * read notice describes the list, not an item, so it outlives navigation
   * and is answered only by a read that lands. */
  const clearError = useCallback(
    () => setError((prev) => (prev?.from === "operation" ? null : prev)),
    [],
  );

  const remove = useCallback(
    (scope: Scope, name: string) =>
      mutate(
        async () => {
          await library.remove(scope, name);
          // Dropped from the list HERE, not left to the re-read: for a delete
          // a kept stale list shows the user the thing they just removed.
          setRows((current) =>
            current === null ? current : current.filter((row) => !sameRef(row, { scope, name })),
          );
        },
        (e) => `Delete failed: ${describeError(e)}`,
      ),
    [library, mutate, sameRef],
  );

  return {
    rows,
    error: error?.text ?? null,
    // From `readFailed`, NOT from the error — the view may clear a notice, and
    // it must not be able to clear a FACT by doing so.
    listTrusted: !readFailed,
    clearError,
    save,
    rename,
    remove,
  };
}
