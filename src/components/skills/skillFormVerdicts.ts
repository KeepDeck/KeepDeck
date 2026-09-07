/**
 * Every verdict the skills editor reaches about the draft in hand — the
 * library-generic ones ([`libraryVerdicts`]: is this name taken, is it ours
 * to judge, did the skill vanish) composed with the one that is a skill's
 * own (its description), and `canSave`, the verdict the write machine gates
 * on.
 *
 * The object is also the write machine's supply line: `performSubmit`
 * receives THIS and never the library, so it cannot re-derive `vanished`
 * from a second reading of the world.
 */
import {
  sameSkillRef,
  skillDescriptionProblem,
  skillNameProblem,
  type SkillDraft,
  type SkillLibraryScope,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import {
  libraryVerdicts,
  type LibraryVerdicts,
  type Selection as LibrarySelection,
  type WritableSelection as LibraryWritableSelection,
} from "../library/libraryVerdicts";

type SkillDescriptionProblem = ReturnType<typeof skillDescriptionProblem>;

/** Which stored skill the editor shows, or the create form for a scope.
 * The view mode is the read-only BUNDLED row; an edit or a create names a
 * LIBRARY scope only. */
export type Selection = LibrarySelection<SkillLibraryScope>;

/** A selection the write machine may act on — the bundled tier absent BY
 * TYPE, so no writer needs a guard against it. */
export type WritableSelection = LibraryWritableSelection<SkillLibraryScope>;

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

export interface SkillFormVerdicts extends Omit<LibraryVerdicts, "retitled"> {
  descriptionProblem: SkillDescriptionProblem;
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
  const { retitled, ...shared } = libraryVerdicts({
    selection,
    form,
    rows: skills,
    listTrusted,
    busy,
    dirty,
    nameTouched,
    rowAt: skillAt,
    nameProblemOf: skillNameProblem,
  });

  // The rule itself is the domain's, including why empty is refused
  // (kimi silently drops a skill whose description is empty, field-
  // verified 0.27, so saving one would "work" and never reach the agent).
  const descriptionProblem = skillDescriptionProblem(form.description);

  // `nameTaken` is a courtesy — it catches the collision before the round
  // trip and can name the skill. It is NOT the guard: the backend refuses a
  // create over an existing skill regardless. THE RETITLE HATCH: a skill
  // deleted under the user is unsavable as an update, but the draft on
  // screen is the only copy — giving it a new name turns the save into a
  // create. `!isView` belongs here with its siblings: the write machine is
  // meant to be blind to the tier BY CONSTRUCTION.
  const canSave =
    selection !== null &&
    !shared.isView &&
    dirty &&
    (!shared.vanished || retitled) &&
    shared.nameProblem === null &&
    !shared.nameTaken &&
    descriptionProblem === null;

  return Object.freeze({ ...shared, descriptionProblem, canSave });
}
