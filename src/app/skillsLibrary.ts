import {
  composeSkillFile,
  normalizeSkillDescription,
  orphanedFrontmatterLine,
  renameSkillFile,
  sameSkillScope,
  skillDescriptionProblem,
  skillDraftOf,
  skillNameProblem,
  skillScopeOf,
  SKILL_NAME_RULE,
  type SkillDraft,
  type SkillScope,
} from "../domain/skills";
import { deleteSkill, fetchSkills, renameSkill, saveSkill } from "../ipc/skills";
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

/**
 * One stored skill as THIS layer speaks of it: a scope, a name, its bytes.
 *
 * Not the wire DTO. `StoredSkill` mirrors the Rust struct field for field
 * (`scope: "global" | "workspace"` beside a nullable `wsId`), and letting it
 * through made it the currency of the library's public `list`, the editor's view
 * state, both views and a React key — four layers a backend field rename would
 * reach. The domain already refuses to touch it for exactly this reason
 * (`skillScopeOf` takes the row structurally); above the adapter a scope is a
 * `SkillScope`, so nothing upstream re-derives one.
 */
export interface LibrarySkill {
  scope: SkillScope;
  name: string;
  content: string;
}

/** The stored library itself. Injected so the owner can be driven without IPC,
 * and so the one adapter that knows the Rust command names stays below. */
export interface SkillsStorage {
  fetch(): Promise<LibrarySkill[]>;
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
  list(scope?: SkillScope): Promise<LibrarySkill[]>;
  /** One skill as the editable draft. REFUSES a name that scope does not hold,
   * with the same sentence every other operation gives for an absent skill —
   * a nullable read would leave each door to word that refusal itself, and
   * they already disagreed on it. */
  read(scope: SkillScope, name: string): Promise<SkillDraft>;
  /**
   * Write a new skill. Refused if the name is already taken in that scope.
   *
   * A caller's `extraFrontmatter` is ignored — hand-added keys are not authored
   * through this library, they are only ever PRESERVED from what is already on
   * disk (see `update`), so a create writes exactly name, description and body.
   */
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
   *
   * Refused if `to` is already taken, before anything is written — the storage
   * refuses it too, but only after the frontmatter rewrite has landed, and that
   * leaves two directories declaring one skill with no way back.
   */
  rename(scope: SkillScope, from: string, to: string): Promise<void>;
  /** Remove a skill, assets included. Refused if there is none by that name:
   * the storage underneath calls a missing directory a success, which would
   * answer "done" to a caller that named the wrong skill. */
  remove(scope: SkillScope, name: string): Promise<void>;
  /**
   * Be told when the library changed, and unsubscribe with the returned
   * function.
   *
   * Needed since the library got a SECOND door: a view could refresh after its
   * own writes, but an agent's `skills.delete` through the command registry left
   * the open editor listing a skill that is gone — and every save against it
   * failed, with the typed text having nowhere to land. Any mutation through this
   * library notifies, whoever made it.
   */
  subscribe(listener: () => void): () => void;
}

/** The adapter over the Tauri commands — the only place their names appear, and
 * the only place the wire's shape does: `fetch` reads the DTO's scope columns
 * into a `SkillScope` here, so no layer above has to. */
export const ipcSkillsStorage: SkillsStorage = {
  fetch: async () =>
    (await fetchSkills()).map((row) => ({
      scope: skillScopeOf(row),
      name: row.name,
      content: row.content,
    })),
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
  const listeners = new Set<() => void>();

  /** THE scope filter — "which stored rows belong to this library" is asked by
   * every read, so it is answered once here rather than at each caller. */
  async function rows(scope?: SkillScope): Promise<LibrarySkill[]> {
    const all = await ports.storage.fetch();
    return scope ? all.filter((row) => sameSkillScope(row.scope, scope)) : all;
  }

  /** One scope's library, read ONCE, answering the two questions every mutation
   * asks of it. Both refusals have their single home here, so no door can forget
   * a check and none can word it differently. The stored ROW rather than a
   * draft: a rename needs the bytes as they are on disk, and everything else
   * derives its draft from the same read. */
  async function library(scope: SkillScope) {
    const all = await rows(scope);
    return {
      existing(name: string): LibrarySkill {
        const stored = all.find((row) => row.name === name);
        if (!stored) throw new Error(`No skill "${name}" in ${describeScope(scope)}`);
        return stored;
      },
      /** Refused BEFORE anything is written. The storage refuses a taken target
       * too, but only after the first half of a rename has already landed — and
       * that state is unrepairable, because a re-run finds the frontmatter
       * already correct and retries only the move, forever. */
      requireFree(name: string): void {
        if (all.some((row) => row.name === name)) {
          throw new Error(`"${name}" is already taken in ${describeScope(scope)}`);
        }
      },
    };
  }

  /**
   * Every mutation goes through here, so "a write makes the staged views stale"
   * is stated once — and states it for a FAILED write too. Once a call has
   * reached the storage the library may have changed whatever it answers: a
   * compound rename's first step lands before its second can fail, and a delete
   * removes children one at a time. Re-staging a library that turns out not to
   * have changed costs one cleared memo, and staging is cheap; keeping a memo
   * that is silently stale costs every agent the skill it should have had.
   *
   * No refusal of OURS gets this far — composing and every precondition run
   * before the call. The storage still has two of its own, and they cost a
   * needless re-stage: it refuses a create whose name is taken and a rename onto
   * a taken target without touching the disk. That is the price of `expectNew`
   * being the guard that survives a library we could not read, and a dropped memo
   * is cheap; do not read this `finally` as "the disk definitely changed".
   */
  async function writeThenRestage(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } finally {
      // Neither of these may turn a landed write into a failed one, nor stop the
      // other from running: a stale staged view and an unrefreshed pane are bad,
      // reporting a successful save as failed is worse.
      try {
        ports.staging.invalidateSkills();
      } catch {
        // Staging's own problem; the write still happened.
      }
      // Same reasoning, same moment, for the readers that are on SCREEN rather
      // than staged.
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A view's refresh is not this write's problem.
        }
      }
    }
  }

  /** One home for the naming refusal — a create and a rename both name the same
   * rule. An UPDATE deliberately does not ask: the name identifies a skill the
   * caller found on disk, and a directory this build's authoring rule would
   * reject (a hand-made `My_Skill`) must still be editable. */
  function requireValidName(name: string): void {
    if (skillNameProblem(name) === null) return;
    throw new Error(`"${name}" is not a valid skill name — ${SKILL_NAME_RULE}`);
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
    // The last guard before we rewrite somebody's file: composing puts the
    // extras after the two keys we author, so an extra that is a CONTINUATION of
    // something above it would land under a finished entry and turn valid YAML
    // into frontmatter no CLI can read. Refuse instead — a skill that cannot be
    // edited here is recoverable; one silently rewritten into garbage is not.
    const orphan = orphanedFrontmatterLine(draft.extraFrontmatter);
    if (orphan !== null) {
      throw new Error(
        `This skill's frontmatter cannot be edited here — KeepDeck would have to move the line "${orphan.trim()}", which changes what YAML reads. Edit SKILL.md directly.`,
      );
    }
    return composeSkillFile({ ...draft, description });
  }

  // Every method is `async` so a refusal reaches the caller the same way a
  // backend failure does — as a rejection. A precondition thrown synchronously
  // would escape a caller that only awaits or `.catch`es.
  return {
    list: rows,
    read: async (scope, name) => skillDraftOf((await library(scope)).existing(name)),

    create: async (scope, draft) => {
      requireValidName(draft.name);
      // Composed BEFORE the wrapper, like every other refusal: a draft the
      // format cannot carry has changed nothing, and must not clear the memo.
      const content = authoredFile({ ...draft, extraFrontmatter: [] });
      await writeThenRestage(() => ports.storage.save(scope, draft.name, content, true));
    },

    update: async (scope, draft) => {
      const stored = skillDraftOf((await library(scope)).existing(draft.name));
      // The stored extras win: they are what is on disk now.
      const content = authoredFile({ ...draft, extraFrontmatter: stored.extraFrontmatter });
      await writeThenRestage(() => ports.storage.save(scope, draft.name, content, false));
    },

    rename: async (scope, from, to) => {
      requireValidName(to);
      const scoped = await library(scope);
      const stored = scoped.existing(from);
      // Both preconditions off ONE read, and both before any write — the
      // collision especially, because refusing it late is what leaves two
      // directories claiming one name.
      scoped.requireFree(to);
      // Computed from the bytes we already read, BEFORE anything moves: nothing
      // between the two writes can then refuse the second one.
      const renamed = renameSkillFile(stored.content, to);
      await writeThenRestage(async () => {
        // The frontmatter FIRST, still under the old directory, because only
        // this order leaves a partial failure repairable by re-running the
        // rename: the file says `to` while the directory still says `from`, the
        // directory wins wherever a skill is read, and a re-run finds nothing
        // left to rewrite and just moves it. The other order consumes `from`
        // with the move, so a re-run can no longer find the skill it must
        // finish renaming — and no other operation offers to.
        if (renamed !== null) await ports.storage.save(scope, from, renamed, false);
        await ports.storage.rename(scope, from, to);
      });
    },

    remove: async (scope, name) => {
      (await library(scope)).existing(name);
      await writeThenRestage(() => ports.storage.remove(scope, name));
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
