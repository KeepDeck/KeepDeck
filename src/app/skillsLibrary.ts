import {
  composeSkillFile,
  isValidSkillName,
  normalizeSkillDescription,
  renameSkillFile,
  sameSkillScope,
  skillDescriptionProblem,
  skillDraftOf,
  skillScopeOf,
  type SkillDraft,
  type SkillScope,
} from "../domain/skills";
import {
  deleteSkill,
  fetchSkills,
  renameSkill,
  saveSkill,
  type StoredSkill,
} from "../ipc/skills";
import type { SkillsInvalidation } from "./worktrees";

/**
 * The owner of the shared skills library ([skills]) — one per app, outside
 * React, like `settingsManager`.
 *
 * It exists because a library write is a SEQUENCE, not a call: refuse a draft
 * the format cannot carry, compose its SKILL.md, persist it, and report the
 * library as changed so the staged views a pane spawn injects are rebuilt. That
 * last step is the one nobody remembers, and forgetting it means a skill that
 * saves fine and then never reaches an agent.
 *
 * **Every precondition lives here, not at a door.** The storage underneath
 * cannot enforce them: `save` writes whether or not the skill exists (so an
 * update would silently CREATE), and `delete` treats a missing directory as
 * success. With the guards at one door, the other door — the editor — resurrects
 * skills an agent deleted and duplicates ones it renamed. Two doors reach this
 * library today and more will; the rules are its own.
 *
 * Validation is the DOMAIN's rules, applied here rather than only in the editor:
 * the editor's checks light up its form, these cannot be bypassed.
 */

/** The stored library itself. Injected so the owner can be driven without IPC,
 * and so the one adapter that knows the Rust command names stays below. */
export interface SkillsStorage {
  fetch(): Promise<StoredSkill[]>;
  save(
    scope: SkillScope,
    name: string,
    content: string,
    expectNew: boolean,
  ): Promise<void>;
  rename(scope: SkillScope, from: string, to: string): Promise<void>;
  remove(scope: SkillScope, name: string): Promise<void>;
}

export interface SkillsLibraryPorts {
  storage: SkillsStorage;
  /** Whose staged views a write makes stale — the worktree manager's narrow
   * role interface, taken as a port rather than the manager itself. */
  staging: SkillsInvalidation;
}

export interface SkillsLibrary {
  /**
   * The stored skills — one scope's, or every scope's when none is named (the
   * editor groups them itself). THROWS on a backend failure: an empty library
   * and one that could not be read must never arrive as the same value — a
   * caller that shows "you have no skills" for an unreachable backend is lying.
   */
  list(scope?: SkillScope): Promise<StoredSkill[]>;
  /** One skill as the editable draft. REFUSES a name that scope does not hold,
   * with the same sentence every other operation gives for an absent skill —
   * a nullable read would leave each door to word that refusal itself, and
   * they already disagreed on it. */
  read(scope: SkillScope, name: string): Promise<SkillDraft>;
  /** Write a new skill. Refused if the name is already taken in that scope. */
  create(scope: SkillScope, draft: SkillDraft): Promise<void>;
  /**
   * Overwrite an existing skill — refused if there is none by that name, so an
   * update can never turn into a create.
   *
   * Only the name, description and body are the caller's; the stored file's
   * other frontmatter (`allowed-tools`, `license`) is re-read and carried over,
   * so a caller that cannot send those keys back does not eat them, and one that
   * captured them earlier does not write a stale copy over a later hand edit.
   */
  update(scope: SkillScope, draft: SkillDraft): Promise<void>;
  /**
   * Rename a skill: move its directory — assets travel along — and rewrite the
   * frontmatter `name:` to match, because the CLIs read that field and a
   * directory saying one name over a file saying another is a skill with two
   * identities. That one line is ALL it rewrites: a rename authors nothing, so
   * it neither re-composes the file nor applies the rules a draft written here
   * must pass.
   */
  rename(scope: SkillScope, from: string, to: string): Promise<void>;
  /** Remove a skill, assets included. Refused if there is none by that name:
   * the storage underneath calls a missing directory a success, which would
   * answer "done" to a caller that named the wrong skill. */
  remove(scope: SkillScope, name: string): Promise<void>;
}

/** The adapter over the Tauri commands — the only place their names appear. */
export const ipcSkillsStorage: SkillsStorage = {
  fetch: fetchSkills,
  save: saveSkill,
  rename: renameSkill,
  remove: deleteSkill,
};

/** How a scope reads inside a refusal. Deliberately WITHOUT the workspace id:
 * no surface in the app shows one, so naming it would identify the library to
 * nobody, and the caller already knows which workspace it asked about. */
const describeScope = (scope: SkillScope): string =>
  scope.kind === "global" ? "the global library" : "this workspace's library";

export function createSkillsLibrary(ports: SkillsLibraryPorts): SkillsLibrary {
  /** THE scope filter — "which stored rows belong to this library" is asked by
   * every read, so it is answered once here rather than at each caller. */
  async function rows(scope?: SkillScope): Promise<StoredSkill[]> {
    const all = await ports.storage.fetch();
    return scope ? all.filter((row) => sameSkillScope(skillScopeOf(row), scope)) : all;
  }

  /** The STORED row, or the one refusal every operation that needs an existing
   * skill gives — so the sentence has one home and no door can forget the
   * check. The row rather than the draft: a rename needs the bytes as they are
   * on disk, and everything else derives its draft from the same read. */
  async function existing(scope: SkillScope, name: string): Promise<StoredSkill> {
    const stored = (await rows(scope)).find((row) => row.name === name);
    if (!stored) throw new Error(`No skill "${name}" in ${describeScope(scope)}`);
    return stored;
  }

  /**
   * Every mutation goes through here, so "a write makes the staged views stale"
   * is stated once — including when a COMPOUND mutation fails partway. `changed`
   * marks the point after which the library on disk differs from what is
   * staged; a failure past it still invalidates, because the staged views ARE
   * stale by then. A write that failed before changing anything does not:
   * dropping the memo would re-stage the whole library on the next spawn for
   * nothing.
   */
  async function writeThenRestage(
    write: (changed: () => void) => Promise<void>,
  ): Promise<void> {
    let dirty = false;
    try {
      await write(() => {
        dirty = true;
      });
      dirty = true;
    } finally {
      if (dirty) ports.staging.invalidateSkills();
    }
  }

  /** One home for the naming refusal — a create and a rename both name the same
   * rule. An UPDATE deliberately does not ask: the name identifies a skill the
   * caller found on disk, and a directory this build's authoring rule would
   * reject (a hand-made `My_Skill`) must still be editable. */
  function requireValidName(name: string): void {
    if (isValidSkillName(name)) return;
    throw new Error(
      `"${name}" is not a valid skill name — lowercase letters, digits and hyphens only`,
    );
  }

  /** The stored form of a draft someone AUTHORED here: fold the description
   * onto its one frontmatter line, then refuse what the format cannot carry.
   * Normalizing before validating means a pasted or agent-written multi-line
   * description lands as a valid scalar instead of being rejected.
   *
   * Only `create` and `update` compose — the two operations whose input is a
   * caller's draft. Nothing that merely edits a file already on disk comes
   * through here: applying an authoring rule to content nobody sent refuses
   * work over a rule its author never had a chance to satisfy, and every rule
   * added here would silently acquire that second jurisdiction. */
  function authoredFile(draft: SkillDraft): string {
    const description = normalizeSkillDescription(draft.description).trim();
    switch (skillDescriptionProblem(description)) {
      case "empty":
        throw new Error("A skill needs a description — agents pick skills by it");
      case "multiline":
        throw new Error("A skill description must be a single line");
    }
    return composeSkillFile({ ...draft, description });
  }

  // Every method is `async` so a refusal reaches the caller the same way a
  // backend failure does — as a rejection. A precondition thrown synchronously
  // would escape a caller that only awaits or `.catch`es.
  return {
    list: rows,
    read: async (scope, name) => skillDraftOf(await existing(scope, name)),

    create: async (scope, draft) => {
      requireValidName(draft.name);
      await writeThenRestage(() =>
        ports.storage.save(scope, draft.name, authoredFile(draft), true),
      );
    },

    update: async (scope, draft) => {
      const stored = skillDraftOf(await existing(scope, draft.name));
      await writeThenRestage(() =>
        ports.storage.save(
          scope,
          draft.name,
          // The stored extras win: they are what is on disk now.
          authoredFile({ ...draft, extraFrontmatter: stored.extraFrontmatter }),
          false,
        ),
      );
    },

    rename: async (scope, from, to) => {
      requireValidName(to);
      const stored = await existing(scope, from);
      // Computed from the bytes we already read, BEFORE anything moves: nothing
      // between the two writes can then refuse the second one.
      const renamed = renameSkillFile(stored.content, to);
      await writeThenRestage(async (changed) => {
        // The frontmatter FIRST, still under the old directory, because only
        // this order leaves a partial failure repairable by re-running the
        // rename: the file says `to` while the directory still says `from`, the
        // directory wins wherever a skill is read, and a re-run finds nothing
        // left to rewrite and just moves it. The other order consumes `from`
        // with the move, so a re-run can no longer find the skill it must
        // finish renaming — and no other operation offers to.
        if (renamed !== null) {
          await ports.storage.save(scope, from, renamed, false);
          changed();
        }
        await ports.storage.rename(scope, from, to);
      });
    },

    remove: async (scope, name) => {
      await existing(scope, name);
      await writeThenRestage(() => ports.storage.remove(scope, name));
    },
  };
}
