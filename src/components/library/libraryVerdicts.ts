/**
 * The verdicts every library editor reaches about the draft in hand that do
 * not depend on what the item IS: is this name taken, is it even ours to
 * judge, did the item vanish under us, is the user retitling a vanished one.
 *
 * A pure function of the world it is given: no React, no store. The verdicts
 * arrive as ONE object because they are one family — each is about the same
 * draft at the same instant, and handing them out separately is what let
 * them drift before. Each library composes its own verdicts on top of these
 * (a skill judges its description, a server its body) and adds `canSave`,
 * the one verdict the write machine gates on.
 */

/** Which stored item the editor shows, or the create form for a scope. The
 * view mode is a read-only row (skills' bundled tier); a library without
 * such a tier simply never produces one. */
export type Selection<Scope> =
  | { mode: "edit"; scope: Scope; name: string }
  | { mode: "view"; name: string }
  | { mode: "create"; scope: Scope };

/**
 * A selection the write machine may act on.
 *
 * The read-only tier is absent BY TYPE rather than by a branch: a view
 * selection cannot be passed to a writer, so no writer needs a guard against
 * one — and a second guard is a second place to forget.
 */
export type WritableSelection<Scope> = Extract<
  Selection<Scope>,
  { mode: "edit" } | { mode: "create" }
>;

export type NameProblem = "empty" | "invalid" | null;

/** The world a verdict is reached against. */
export interface LibraryVerdictInput<Scope, Row, Form extends { name: string }> {
  selection: Selection<Scope> | null;
  form: Form;
  /** The listed library; `null` while no read has landed. */
  rows: Row[] | null;
  /** Whether the last read succeeded — absence proves nothing otherwise. */
  listTrusted: boolean;
  /** One of our OWN writes is in flight. */
  busy: boolean;
  dirty: boolean;
  /** Whether the user has typed in the Name field. */
  nameTouched: boolean;
  /** The listed row at (scope, name) — "which row IS this one", asked once. */
  rowAt(rows: Row[] | null, scope: Scope, name: string): Row | undefined;
  /** The library's own name rule. */
  nameProblemOf(name: string): NameProblem;
}

export interface LibraryVerdicts {
  /** The read-only tier: a view selection never authors anything. */
  isView: boolean;
  /** Another item in this scope holds the name. */
  nameTaken: boolean;
  /** The name is being AUTHORED here — a create, or an edit that changes it. */
  authoringName: boolean;
  /** The name verdict for the GATE. */
  nameProblem: NameProblem;
  /** The name verdict for the MESSAGE — the same verdict, held back until
   * the user has started. */
  shownNameProblem: NameProblem;
  /** The open item is gone from the library — another door deleted or
   * renamed it under us. */
  vanished: boolean;
  /** The user gave a vanished draft a new name — the retitle hatch: the save
   * becomes a create, so the only copy of the text is not stranded behind a
   * dead button. */
  retitled: boolean;
}

export function libraryVerdicts<Scope, Row, Form extends { name: string }>({
  selection,
  form,
  rows,
  listTrusted,
  busy,
  dirty,
  nameTouched,
  rowAt,
  nameProblemOf,
}: LibraryVerdictInput<Scope, Row, Form>): LibraryVerdicts {
  // Named once — every write-adjacent verdict below asks it.
  const isView = selection?.mode === "view";

  // The open item is gone. NOT while one of our own writes is in flight: a
  // rename re-anchors the selection to a name the list does not hold yet —
  // by design, since the save that follows owns the re-read. And not over a
  // list whose last read failed, where absence proves nothing at all.
  const vanished =
    selection?.mode === "edit" &&
    rows !== null &&
    !busy &&
    listTrusted &&
    rowAt(rows, selection.scope, selection.name) === undefined;

  // Taken = another item in this scope holds the name. Keeping your OWN name
  // is not a collision. A view row never authors anything, so no name is judged.
  const nameTaken =
    selection !== null &&
    !isView &&
    !(selection.mode === "edit" && selection.name === form.name) &&
    rowAt(rows, selection.scope, form.name) !== undefined;

  // The name is judged only where it is being AUTHORED. An INHERITED name is
  // not the editor's to refuse: the library deliberately skips this rule on
  // an update for the same reason, so a hand-made name stays editable.
  const authoringName =
    selection !== null &&
    !isView &&
    (selection.mode === "create" || selection.name !== form.name);

  const nameProblem = authoringName ? nameProblemOf(form.name) : null;

  // The GATE uses the verdict from the first render; the MESSAGE waits — but
  // only until the user has STARTED, not until they touch this particular
  // field. A pristine form still says nothing.
  const shownNameProblem =
    nameTouched || dirty || form.name !== "" ? nameProblem : null;

  const retitled =
    selection !== null && selection.mode === "edit" && form.name !== selection.name;

  return {
    isView,
    nameTaken,
    authoringName,
    nameProblem,
    shownNameProblem,
    vanished,
    retitled,
  };
}
