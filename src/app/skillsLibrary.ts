import {
  composeSkillFile,
  frontmatterObstacle,
  normalizeSkillDescription,
  renameSkillFile,
  sameSkillScope,
  skillDescriptionProblem,
  skillDraftOf,
  skillNameProblem,
  SKILL_NAME_RULE,
  type SkillDraft,
  type SkillScope,
} from "../domain/skills";
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
 * **Every precondition lives here, not at a door** — with ONE stated exception.
 * The storage underneath cannot enforce most of them: `save` writes whether or
 * not the skill exists (so an update would silently CREATE), and `delete` treats
 * a missing directory as success. With the guards at one door, the other door —
 * the editor — resurrects skills an agent deleted and duplicates ones it renamed.
 * Two doors reach this library today and more will; the rules are its own.
 *
 * The exception is a name COLLISION, which only the storage can answer, because
 * only it sees the disk: a directory with no readable SKILL.md is not in any list
 * we could check against, and yet it blocks a move. So `create` delegates that
 * refusal entirely, and `rename` orders its writes so the storage refuses first.
 * Checking it here as well is a courtesy for the message, never the guard.
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
   * Write a new skill.
   *
   * Refused if the name is taken — by the STORAGE, deliberately, which is the one
   * precondition this library does not answer itself: the check has to hold when
   * the library could not be read at all, and a check of our own would refuse
   * every create in that state instead of the colliding one. So the refusal is
   * worded by the layer below, and it is the only one that is.
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

/** How a scope reads inside a refusal. Deliberately WITHOUT the workspace id:
 * no surface in the app shows one, so naming it would identify the library to
 * nobody, and the caller already knows which workspace it asked about. */
const describeScope = (scope: SkillScope): string =>
  scope.kind === "global" ? "the global library" : "this workspace's library";

/** One wording for a collision, so the courtesy check and anything that re-words
 * the storage's own refusal say the same thing. */
const takenMessage = (name: string, scope: SkillScope): string =>
  `"${name}" is already taken in ${describeScope(scope)}`;

/** One wording for "this file is beyond what we can rewrite", with the advice
 * that follows it — the advice is the part that must not drift, because it is
 * what the user does next. */
const beyondUs = (what: string, obstacle: string): string =>
  `${what} — ${obstacle}. Edit its SKILL.md directly.`;

export function createSkillsLibrary(ports: SkillsLibraryPorts): SkillsLibrary {
  const listeners = new Set<() => void>();
  let notifying = false;

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
      /**
       * A COURTESY refusal, not the guard. It answers from the listed rows, and
       * the storage answers from the directory — a strictly wider condition, so a
       * leftover directory with no readable SKILL.md passes here and is refused
       * there. The guard has to be the storage's, because only it sees the disk;
       * this one exists to name the collision in the library's own words while it
       * can.
       */
      requireFree(name: string): void {
        if (all.some((row) => row.name === name)) throw new Error(takenMessage(name, scope));
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
      // than staged. Not re-entrant: a listener that writes would be notified by
      // its own write, and nothing would bound the chain.
      if (!notifying) {
        notifying = true;
        try {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch {
              // A view's refresh is not this write's problem.
            }
          }
        } finally {
          notifying = false;
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
    return composeSkillFile({ ...draft, description });
  }

  /** The last guard before we rewrite somebody's file. Asked of the STORED bytes,
   * not of a parsed draft: only the file itself can say whether re-composing it
   * would change what a YAML reader sees, and the answer belongs to the codec
   * that would do the composing. */
  function requireRewritable(stored: string): void {
    const obstacle = frontmatterObstacle(stored);
    if (obstacle !== null) {
      throw new Error(beyondUs("This skill cannot be edited here", obstacle));
    }
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
      const row = (await library(scope)).existing(draft.name);
      requireRewritable(row.content);
      // The stored extras win: they are what is on disk now.
      const stored = skillDraftOf(row);
      const content = authoredFile({ ...draft, extraFrontmatter: stored.extraFrontmatter });
      await writeThenRestage(() => ports.storage.save(scope, draft.name, content, false));
    },

    rename: async (scope, from, to) => {
      requireValidName(to);
      const scoped = await library(scope);
      const stored = scoped.existing(from);
      // A courtesy, so a collision we CAN see is named in our own words.
      scoped.requireFree(to);
      // Computed before anything moves, so the one refusal that used to arrive too
      // late — a frontmatter whose stated name we cannot restate — arrives now.
      const renamed = renameSkillFile(stored.content, to);
      if (renamed.kind === "unsupported") {
        throw new Error(beyondUs(`Cannot rename "${from}"`, renamed.reason));
      }
      await writeThenRestage(async () => {
        // The MOVE FIRST, and this order is load-bearing. "Is this name taken" is
        // answered here from the listed rows and there from the directory — wider,
        // because a directory with no readable SKILL.md is not listed. Writing the
        // content first meant such a target passed our check, the frontmatter
        // rewrite landed, the move was refused, and the source file was left
        // declaring the OTHER skill's name with nothing able to repair it: a re-run
        // finds the frontmatter already correct and retries only the move, forever.
        // Move first and the storage — the only layer that sees the disk — refuses
        // before a single byte is written.
        await ports.storage.rename(scope, from, to);
        // A failure HERE leaves the directory moved and its frontmatter naming the
        // old skill. Mild by comparison and self-announcing: the directory wins
        // wherever a skill is read, so the skill is listed and editable under its
        // new name. The repair is the next save — or, for the one file a save
        // cannot touch (a stored description this build refuses to author, which is
        // any empty one), renaming it once more, which splices the frontmatter with
        // no authoring gate in the way.
        if (renamed.kind === "rewritten") {
          await ports.storage.save(scope, to, renamed.content, false);
        }
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
