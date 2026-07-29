import { useCallback, useSyncExternalStore } from "react";
import {
  gitStatusSnapshot,
  subscribeGitStatus,
  type GitStatusSnapshot,
} from "../gitStatusFeed";

/**
 * One repo's live status, read from the shared per-repo feed
 * (`gitStatusFeed`): load on first subscribe, then follow the repo through
 * `services.git.watch` — edits, staging, commits and checkouts all land here
 * without any manual refresh (there deliberately is no button).
 *
 * The hook is a SUBSCRIPTION, not an owner. Two surfaces on the same repo —
 * the tab's change list and an open diff peek — share one feed, so the second
 * one to mount joins at the settled snapshot instead of starting cold and
 * making every effect keyed on `version` fire twice.
 *
 * `version` bumps on every resolved read, including a failed one: consumers
 * re-read on it, and an open peek must hear that the repo it is showing has
 * gone away rather than keep displaying the hunks it read before.
 */
export function useGitStatus(repo: string): GitStatusSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeGitStatus(repo, onChange),
    [repo],
  );
  const snapshot = useCallback(() => gitStatusSnapshot(repo), [repo]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
