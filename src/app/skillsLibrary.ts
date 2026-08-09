import {
  composeSkillFile,
  isValidSkillDescription,
  isValidSkillName,
  normalizeSkillDescription,
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
 * It exists because a library write is a SEQUENCE, not a call: validate the
 * draft, compose its SKILL.md, persist it, and report the library as changed so
 * the staged views a pane spawn injects are rebuilt. That last step is the one
 * nobody remembers, and forgetting it means a skill that saved fine and then
 * never reached an agent. The sequence lived inside a React hook, which put it
 * out of reach of every non-React caller — so the command registry, and through
 * it MCP, could only have duplicated it.
 *
 * Validation is the DOMAIN's rules ([`isValidSkillName`],
 * [`isValidSkillDescription`]), applied here rather than only in the editor:
 * the editor's checks light up its form, this one cannot be bypassed. An empty
 * description is refused for the reason the editor gives it — some CLIs
 * silently drop a skill without one, so saving it would "work" and never
 * reach the agent.
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
   * Every stored skill, both scopes. THROWS on a backend failure: an empty
   * library and one that could not be read must never arrive as the same
   * value — a caller that shows "you have no skills" for an unreachable
   * backend is lying.
   */
  list(): Promise<StoredSkill[]>;
  /** Write a new skill. Refused if the name is already taken in that scope —
   * the backend decides, so the guard holds even when the library could not
   * be listed. */
  create(scope: SkillScope, draft: SkillDraft): Promise<void>;
  /** Overwrite an existing skill in place. */
  update(scope: SkillScope, draft: SkillDraft): Promise<void>;
  /** Move a skill's directory; its assets travel along. */
  rename(scope: SkillScope, from: string, to: string): Promise<void>;
  remove(scope: SkillScope, name: string): Promise<void>;
}

/** The adapter over the Tauri commands — the only place their names appear. */
export const ipcSkillsStorage: SkillsStorage = {
  fetch: fetchSkills,
  save: saveSkill,
  rename: renameSkill,
  remove: deleteSkill,
};

export function createSkillsLibrary(ports: SkillsLibraryPorts): SkillsLibrary {
  /**
   * Every mutation goes through here, so "a write makes the staged views
   * stale" is stated once. Only a write that SUCCEEDED invalidates: a failed
   * one changed nothing, and dropping the memo anyway would re-stage the
   * library on the next spawn for no reason.
   */
  async function persist(write: () => Promise<void>): Promise<void> {
    await write();
    ports.staging.invalidateSkills();
  }

  /** One home for the naming refusal — a create, an update and a rename all
   * name the same rule, and two copies of the sentence would drift. */
  function requireValidName(name: string): void {
    if (isValidSkillName(name)) return;
    throw new Error(
      `"${name}" is not a valid skill name — lowercase letters, digits and hyphens only`,
    );
  }

  /** The stored form of a draft: fold the description onto its one
   * frontmatter line, then refuse what the format cannot carry. Normalizing
   * before validating means a pasted or agent-written multi-line description
   * lands as a valid scalar instead of being rejected. */
  function fileFor(draft: SkillDraft): string {
    requireValidName(draft.name);
    const description = normalizeSkillDescription(draft.description).trim();
    if (description === "") {
      // Not a formality: agents pick skills by description, and some drop a
      // skill that has none, so this would save and then never take effect.
      throw new Error("A skill needs a description — agents pick skills by it");
    }
    if (!isValidSkillDescription(description)) {
      throw new Error("A skill description must be a single line");
    }
    return composeSkillFile({ ...draft, description });
  }

  // Every method is `async` so a refusal reaches the caller the same way a
  // backend failure does — as a rejection. A validation error thrown
  // synchronously would escape a caller that only awaits or `.catch`es.
  return {
    list: async () => await ports.storage.fetch(),

    create: async (scope, draft) =>
      await persist(() => ports.storage.save(scope, draft.name, fileFor(draft), true)),

    update: async (scope, draft) =>
      await persist(() => ports.storage.save(scope, draft.name, fileFor(draft), false)),

    rename: async (scope, from, to) => {
      requireValidName(to);
      await persist(() => ports.storage.rename(scope, from, to));
    },

    remove: async (scope, name) => await persist(() => ports.storage.remove(scope, name)),
  };
}
