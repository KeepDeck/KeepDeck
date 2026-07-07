import type { GitPosition } from "../domain/deck";

export interface GitBadge {
  label: string;
  title: string;
}

/** Presentation mapping for a runtime git HEAD observation. */
export function gitBadge(position: GitPosition | undefined): GitBadge | null {
  if (!position) return null;
  if (position.branch) return { label: position.branch, title: position.branch };
  if (position.head) return { label: position.head.slice(0, 7), title: position.head };
  return null;
}
