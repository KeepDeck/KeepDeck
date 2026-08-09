import { vi } from "vitest";
import type { SkillsLibrary } from "./skillsLibrary";

/**
 * A do-nothing skills library for suites that only pass one through.
 *
 * Its own module, not `coreCommands/testSupport`: that module installs
 * `vi.mock`s for the worktree IPC and the settings manager the moment it is
 * imported, and a suite taking this fake must not inherit them.
 *
 * The return type is what earns its keep — a seventh method on `SkillsLibrary`
 * then fails to compile HERE, once, instead of leaving each copy of the stub to
 * drift on its own.
 */
export function fakeSkillsLibrary(): SkillsLibrary {
  return {
    list: vi.fn(async () => []),
    read: vi.fn(async () => null),
    create: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
