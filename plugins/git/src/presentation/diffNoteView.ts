import type { DiffNote } from "../domain/diff";

/**
 * How the peek words a diff's notes — the non-textual changes the domain
 * hands over as kinds and paths, never as English.
 */

/** One note of a kind per file, plus its paths where it has them — the
 * render key. */
export function noteKey(note: DiffNote): string {
  return note.kind === "unmerged" ? note.kind : `${note.kind}:${note.from}:${note.to}`;
}

export function noteText(note: DiffNote): string {
  switch (note.kind) {
    case "mode":
      return `File mode changed ${note.from} → ${note.to}`;
    case "rename":
      return `Renamed ${note.from} → ${note.to}`;
    case "copy":
      return `Copied from ${note.from}`;
    case "unmerged":
      return "Unmerged — showing the working file with its conflict markers";
  }
}
