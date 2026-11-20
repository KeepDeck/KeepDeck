/**
 * What KeepDeck puts into a pane's directory for a launch: the workspace's
 * staged skills, and what the agent's plugin declares planted in its cwd.
 *
 * Creating a worktree, removing one and taking back what was planted in it
 * are the lifecycle machine's, natively — each one step of an operation it
 * journaled, ordered against every other write into that folder. What stays
 * here are the ports a spawn plan needs.
 *
 * Vocabulary: worktrees are INFRASTRUCTURE — the pane-directory owner — while
 * skills are the CAPABILITY PLATFORM. Features meet this owner at ports, and
 * runtime.ts is the composition root that wires them; keeping those nouns
 * explicit prevents an infrastructure/feature dependency from looking like a
 * harmless convenience import.
 */
import type { CwdArm, WorkspaceRef } from "@keepdeck/plugin-api";
import type { Workspace } from "../../domain/deck";

/** The deck as staging reads it: the name a stage's report goes under. */
export interface WorktreeDeckView {
  /** The workspace's name as the user sees it now; null once that lifetime
   * is gone, even while a new workspace holds its id. */
  nameOf(workspace: WorkspaceRef): string | null;
}

/** The staged skills the spawn hook consumes: the bare view and each skill as
 * text. Kept as this infrastructure port rather than importing the skills
 * feature's IPC DTO: the owner states what a launch is handed, while the
 * feature owns the wire. */
export interface WorktreeSkillViews {
  dir: string;
  skills: { name: string; content: string }[];
}

/** The staged skills a spawn plan asks for. */
export interface StagedSkills {
  /**
   * The workspace's staged shared skills, ready for a spawn plan. `null` =
   * nothing to inject: an empty library, or a staging that failed — the pane
   * then spawns without skills.
   *
   * Staged afresh on every ask — every launch, new or resumed, gets the views
   * rebuilt from the library as it is now, never an earlier answer. The DISK
   * key is the durable id; the instance only says which lifetime a stage's
   * report belongs to.
   */
  skillsFor(workspace: WorkspaceRef): Promise<WorktreeSkillViews | null>;
}

/** What the skills LIBRARY needs from this owner: a way to say the library
 * moved. Held by `skillsLibrary`, which reports it after every successful write
 * — the editor reaches it only through that owner. */
export interface SkillsInvalidation {
  /** What staging reads changed — the library (any scope), or the claim that
   * gates the bundled tier: what earlier stages said they could not hand out
   * whole speaks of something that is gone, so it is forgotten — and a stage
   * already asked for does not say it after this. */
  invalidateSkills(): void;
}

/** One plugin's complete set of plantings for one cwd — the infrastructure
 * port's own shape (the arming IPC's DTO stays that feature's). */
export interface CwdArmRequest {
  pluginId: string;
  workspaceId: string;
  cwd: string;
  arms: readonly CwdArm[];
  skillsDir: string | null;
}

/** What one arming pass planted, by path, and what it refused and why. */
export interface CwdArmReport {
  armed: string[];
  refused: { path: string; reason: string }[];
}

/** Planting what an agent's plugin declares in a pane's cwd (`arm.plan`). */
export interface CwdArming {
  /** One plugin's complete set for one cwd; never throws. */
  armCwd(request: CwdArmRequest): Promise<CwdArmReport>;
}

/** The skills feature's part, as the composition root builds it. */
export type WorktreeSkillsPlanting = StagedSkills & SkillsInvalidation;

/** The whole owner, as the composition root builds it. Consumers take the role
 * they need instead of this: a fake that has to stub methods its subject never
 * calls is a fake that stops catching anything. */
export type WorktreePlantings = StagedSkills & SkillsInvalidation & CwdArming;

/**
 * The deck view over a live snapshot.
 *
 * Here rather than assembled at the composition root: the LIFETIME match is
 * load-bearing (the instance, not the id, names one lifetime, so a reference
 * that outlived its workspace is handed no name) and it was stated only in a
 * closure with no test.
 */
export function deckViewOf(workspaces: () => Workspace[]): WorktreeDeckView {
  return {
    nameOf: (ref) =>
      workspaces().find((candidate) => candidate.id === ref.id && candidate.instance === ref.instance)?.name ??
      null,
  };
}
