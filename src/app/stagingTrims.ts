/**
 * What staging could not hand agents whole, workspace by workspace — a skill
 * larger than one may be, a link leading out of one, a SKILL.md nobody should
 * read. The user's to fix, in the skill's own folder.
 *
 * A STANDING CONDITION, not an event: each stage replaces what the last one
 * said about its workspace, an empty list included; a library edit drops
 * everything said, since the next stage says it again if it is still true;
 * and a workspace that is gone is forgotten with it. Nothing expires on a
 * timer.
 */
import type { StagingTrim } from "../domain/skills";

/** A stage's verdict on one skill, with the workspace whose stage said it. */
export interface WorkspaceTrim extends StagingTrim {
  workspaceId: string;
  workspaceName: string;
}

export interface StagingTrimStore {
  get(): readonly WorkspaceTrim[];
  subscribe(listener: () => void): () => void;
  /** One stage's word on one workspace: replaces what was said about it
   * before, an empty list included. */
  record(workspace: { id: string; name: string }, trims: readonly StagingTrim[]): void;
  /** Workspaces gone: only what was said about the live ones stands. */
  keep(liveWorkspaceIds: readonly string[]): void;
  /** The library moved: nothing said about it stands until a stage says it
   * again. */
  clear(): void;
}

const sameTrim = (a: WorkspaceTrim, b: WorkspaceTrim): boolean =>
  a.workspaceId === b.workspaceId &&
  a.workspaceName === b.workspaceName &&
  a.scope === b.scope &&
  a.skill === b.skill &&
  a.kind === b.kind &&
  a.path === b.path &&
  a.count === b.count;

export function createStagingTrimStore(): StagingTrimStore {
  let current: readonly WorkspaceTrim[] = [];
  const listeners = new Set<() => void>();
  function publish(next: readonly WorkspaceTrim[]): void {
    // Compared by CONTENT: every stage re-records its workspace, and a stage
    // that found the same must not wake every surface reading it.
    if (next.length === current.length && next.every((trim, i) => sameTrim(trim, current[i]))) return;
    current = next;
    for (const listener of [...listeners]) listener();
  }
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(workspace, trims) {
      publish([
        ...current.filter((trim) => trim.workspaceId !== workspace.id),
        ...trims.map((trim) => ({ ...trim, workspaceId: workspace.id, workspaceName: workspace.name })),
      ]);
    },
    keep(liveWorkspaceIds) {
      const live = new Set(liveWorkspaceIds);
      publish(current.filter((trim) => live.has(trim.workspaceId)));
    },
    clear() {
      publish([]);
    },
  };
}

/** The app's one store, a module singleton for the reason the arm refusals
 * are one: the surfaces that show it are mounted far from the composition
 * root that fills it. */
export const stagingTrims = createStagingTrimStore();
