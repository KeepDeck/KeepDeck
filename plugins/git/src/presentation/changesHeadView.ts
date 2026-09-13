import type { GitStatus } from "@keepdeck/plugin-api";
import type { ChangeGroups } from "../domain/status";

/**
 * What the Changes header carries beside its name: how many paths changed,
 * and how far the branch stands from its upstream — only when it stands
 * anywhere. `↑0 ↓0` on every in-sync branch was noise, and most agent
 * worktrees have no upstream at all.
 */
export interface ChangesHead {
  /** Distinct changed paths; null before the first status lands. */
  count: number | null;
  upstream: { name: string; ahead: number; behind: number } | null;
}

export function changesHead(status: GitStatus | null, groups: ChangeGroups | null): ChangesHead {
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const upstream =
    status?.upstream && (ahead > 0 || behind > 0)
      ? { name: status.upstream, ahead, behind }
      : null;
  return { count: groups ? groups.total : null, upstream };
}
