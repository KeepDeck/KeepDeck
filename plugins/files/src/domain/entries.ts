import type { FsEntry } from "@keepdeck/plugin-api";

/**
 * Sort one directory's children for display: directories first, then
 * everything else (files AND symlinks — a symlink is never resolved, so its
 * real kind is unknown), each group by name, case-insensitively. Pure and
 * total, so the tree's order is stable and predictable regardless of the
 * platform's `readdir` order. Returns a new array; the input is untouched.
 */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const rank = dirRank(a) - dirRank(b);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Directories sort ahead of everything else. */
function dirRank(entry: FsEntry): number {
  return entry.kind === "dir" ? 0 : 1;
}
