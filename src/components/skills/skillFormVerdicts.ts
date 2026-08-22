/**
 * Every verdict the skills editor reaches about the draft in hand — is
 * this name taken, is it even ours to judge, may Save fire, did the
 * skill vanish under us.
 *
 * A pure function of the world it is given: no React, no store. The
 * verdicts arrive as ONE object because they are one family — each is
 * about the same draft at the same instant, and handing them out
 * separately is what let them drift before (a gate that refused an
 * emptied Name while the message stayed hidden, because "empty" counted
 * as invalid at the gate and as "nothing typed yet" at the message).
 *
 * The object is also the write machine's supply line: `performSubmit`
 * receives THIS and never the library, so it cannot re-derive `vanished`
 * from a second reading of the world. Adding the library back to its
 * parameters is the visible change a reviewer has to approve.
 */
import {
  sameSkillRef,
  skillDescriptionProblem,
  skillNameProblem,
  type SkillDraft,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";

type SkillNameProblem = ReturnType<typeof skillNameProblem>;
type SkillDescriptionProblem = ReturnType<typeof skillDescriptionProblem>;

/** Which stored skill the editor shows, or the create form for a scope.
 * The view mode is the read-only BUNDLED row. */
export type Selection =
  | { mode: "edit"; scope: SkillScope; name: string }
  | { mode: "view"; name: string }
  | { mode: "create"; scope: SkillScope };

/**
 * A selection the write machine may act on.
 *
 * The bundled tier is absent BY TYPE rather than by a branch: the
 * docblock above `Selection` has always claimed the write machine never
 * sees a bundled skill "by construction", and this is what makes the
 * claim true. A view selection cannot be passed to a writer, so no
 * writer needs a guard against one — and a second guard is a second
 * place to forget.
 */
export type WritableSelection = Extract<
  Selection,
  { mode: "edit" } | { mode: "create" }
>;

/** The world a verdict is reached against. */
export interface VerdictInput {
  selection: Selection | null;
  form: SkillDraft;
  /** The listed library; `null` while no read has landed. */
  skills: LibrarySkill[] | null;
  /** Whether the last read succeeded — absence proves nothing otherwise. */
  listTrusted: boolean;
  /** One of our OWN writes is in flight. */
  busy: boolean;
  dirty: boolean;
  /** Whether the user has typed in the Name field. */
  nameTouched: boolean;
}

export interface SkillFormVerdicts {
  /** The read-only tier: a view selection never authors anything. */
  isView: boolean;
  /** Another skill in this scope holds the name. */
  nameTaken: boolean;
  /** The name is being AUTHORED here — a create, or an edit that changes it. */
  authoringName: boolean;
  /** The name verdict for the GATE. The domain's own vocabulary, not a
   * string: the editor renders each case its own way, and widening here
   * would let a new verdict reach the view with nothing to say about it. */
  nameProblem: SkillNameProblem;
  /** The name verdict for the MESSAGE — the same verdict, held back until
   * the user has started. */
  shownNameProblem: SkillNameProblem;
  descriptionProblem: SkillDescriptionProblem;
  /** The open skill is gone from the library — an agent deleted or
   * renamed it under us. */
  vanished: boolean;
  canSave: boolean;
}

/** The listed skill at (scope, name) — "which row IS this one" asked
 * once. The library asks the same question of the disk; if identity ever
 * grows (case-insensitive names, trimming), these are the two places
 * that must move together. */
export function skillAt(
  skills: LibrarySkill[] | null,
  scope: SkillScope,
  name: string,
): LibrarySkill | undefined {
  return (skills ?? []).find((s) => sameSkillRef(s, { scope, name }));
}

/** The bundled row at `name` — the view mode's Selection carries no
 * scope (the mode implies it: only bundled rows open views). */
export function bundledRowAt(
  skills: LibrarySkill[] | null,
  name: string,
): LibrarySkill | undefined {
  return (skills ?? []).find(
    (s) => s.scope.kind === "bundled" && s.name === name,
  );
}

export function skillFormVerdicts({
  selection,
  form,
  skills,
  listTrusted,
  busy,
  dirty,
  nameTouched,
}: VerdictInput): SkillFormVerdicts {
  // Named once — every write-adjacent verdict below asks it, so the
  // policy lives in one place instead of five inline comparisons
  // forgetting one of them.
  const isView = selection?.mode === "view";

  // The open skill is gone. NOT while one of our own writes is in flight:
  // a rename re-anchors the selection to a name the list does not hold
  // yet — by design, since the save that follows owns the re-read — so
  // judging it mid-submit calls every rename a disappearance and disables
  // the save that would complete it. And not over a list whose last read
  // failed, where absence proves nothing at all.
  const vanished =
    selection?.mode === "edit" &&
    skills !== null &&
    !busy &&
    listTrusted &&
    skillAt(skills, selection.scope, selection.name) === undefined;

  // Taken = another skill in this scope holds the name. Keeping your OWN
  // name is not a collision — that's just an ordinary save. A bundled row
  // never authors anything, so no name is judged.
  const nameTaken =
    selection !== null &&
    !isView &&
    !(selection.mode === "edit" && selection.name === form.name) &&
    skillAt(skills, selection.scope, form.name) !== undefined;

  // The name is judged only where it is being AUTHORED — a create, or an
  // edit that changes it. An INHERITED name is not the editor's to
  // refuse: the library deliberately skips this rule on an update for the
  // same reason, so a hand-made `My_Skill` (which the Rust side stores
  // and lists happily) stays editable. Judging it here too made that
  // skill openable and unsavable, with a kebab-case complaint under a
  // name the user was not editing — one rule, two doors, opposite
  // answers.
  const authoringName =
    selection !== null &&
    !isView &&
    (selection.mode === "create" || selection.name !== form.name);

  const nameProblem = authoringName ? skillNameProblem(form.name) : null;

  // The GATE uses the verdict from the first render; the MESSAGE waits —
  // but only until the user has STARTED, not until they touch this
  // particular field. Waiting for the field itself meant filling the
  // description first (the natural order on a create form) left Create
  // disabled with nothing at all on screen, which is the failure the
  // verdict exists to prevent. A pristine form still says nothing.
  const shownNameProblem =
    nameTouched || dirty || form.name !== "" ? nameProblem : null;

  // The rule itself is the domain's, including why empty is refused
  // (kimi silently drops a skill whose description is empty, field-
  // verified 0.27, so saving one would "work" and never reach the agent).
  const descriptionProblem = skillDescriptionProblem(form.description);

  // `nameTaken` is a courtesy — it catches the collision before the round
  // trip and can name the skill. It is NOT the guard: it is derived from
  // the listed library, which is empty whenever the read failed, and the
  // backend refuses a create over an existing skill regardless. Disabling
  // Create on a library we could not read would trade a silent overwrite
  // for a silently dead button.
  // THE RETITLE HATCH. A skill deleted under the user is normally
  // unsavable — an update to a directory that is gone can only fail.
  // But refusing outright strands the text on screen behind a dead
  // button, and that draft is the one thing here that exists nowhere
  // else: the file is gone, so what the user is looking at IS the only
  // copy. Giving it a new name turns the save into a create (the write
  // machine reads this same verdict to decide that), so the way out is
  // to retitle: keep the old name and Save stays refused, because that
  // really would be a doomed update.
  const retitled =
    selection !== null &&
    selection.mode === "edit" &&
    form.name !== selection.name;

  // `!isView` belongs here with its siblings, and it was the one
  // write-adjacent verdict without it. Nothing reachable changes: a
  // read-only editor never reports a field change, so a view selection
  // could not become dirty and could not pass the gate anyway. But that
  // made this verdict depend on an invariant kept in a different file —
  // and the write machine is meant to be blind to the tier BY
  // CONSTRUCTION, not by a distant component's good behaviour.
  const canSave =
    selection !== null &&
    !isView &&
    dirty &&
    (!vanished || retitled) &&
    nameProblem === null &&
    !nameTaken &&
    descriptionProblem === null;

  return Object.freeze({
    isView,
    nameTaken,
    authoringName,
    nameProblem,
    shownNameProblem,
    descriptionProblem,
    vanished,
    canSave,
  });
}
