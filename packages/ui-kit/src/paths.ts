/**
 * Path formatting for display. Not path manipulation — these shape a path
 * into something that fits the app's chrome, which is why they live beside
 * the primitives that render them rather than in any one consumer.
 */

/** A path trimmed to its last two segments — enough to tell two worktrees
 * apart in a narrow dock without spending a row on `/Users/…/Projects/…`.
 * A shorter path is returned as-is (minus any leading or trailing slash). */
export function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
