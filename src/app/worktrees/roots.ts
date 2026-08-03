/**
 * The one rule every planting is judged by: which spawn cwds no live
 * workspace claims any more.
 *
 * Its own module because three different concerns ask it — a teardown, the
 * sweep, and the staging memo — and the whole point of this owner is that
 * they ask the SAME question. A second copy is how the skills path came to
 * have guards the MCP path did not.
 */
import type { LiveWorkspace } from "./index";

/** Covers a closed pane, a closed workspace and a doomed worktree alike. */
export function unclaimed(
  candidates: string[],
  live: LiveWorkspace[],
): string[] {
  const claimed = new Set(live.flatMap((ws) => ws.roots));
  return [...new Set(candidates)].filter((root) => !claimed.has(root));
}
