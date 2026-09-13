import type { GitHistory } from "@keepdeck/plugin-api";

/**
 * The History list's lazily GROWING window — how much of the log to ask
 * for. The window is one number: every read re-asks for the whole of it
 * (`git log -n count` carries no diffs — re-listing even thousands of
 * records is cheap), which keeps the list correct when commits land
 * underneath the scroll, with no cursor to invalidate.
 */

/** The page size: the first read asks for this many, each step adds it. */
export const HISTORY_CHUNK = 50;

export function firstWindow(): number {
  return HISTORY_CHUNK;
}

export function widenWindow(count: number): number {
  return count + HISTORY_CHUNK;
}

/** Whether scrolling further could reveal more: the last read filled its
 * whole window. A short repo underfills it, and the list is complete. */
export function windowFilled(history: GitHistory | null, count: number): boolean {
  return history !== null && history.commits.length >= count;
}
