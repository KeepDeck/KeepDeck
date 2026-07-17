import { dirName, type ChangeRow } from "./status";

/**
 * Keyboard navigation over the peek rail's flat row order — pure, like the
 * Files tab's navigator, so it is testable without React or focus. Given the
 * rail's rows in visual order, the row whose diff is open, and an arrow, it
 * returns the row to switch to — or null when the key changes nothing.
 *
 * - Down / Up: the next / previous file, clamped at the ends.
 * - Right / Left: the first file of the next / previous directory group — a
 *   group being a run of adjacent rows sharing a directory. Left lands on
 *   the group's FIRST row, mirroring Right, so the two keys are inverses.
 * - A current row no longer listed (it left the status mid-peek) lands back
 *   on the first row.
 */
export type ArrowKey = "up" | "down" | "left" | "right";

export function navigate(
  rows: ChangeRow[],
  current: ChangeRow,
  key: ArrowKey,
): ChangeRow | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex(
    (row) => row.path === current.path && row.kind === current.kind,
  );
  if (index < 0) return rows[0];

  switch (key) {
    case "down":
      return index < rows.length - 1 ? rows[index + 1] : null;
    case "up":
      return index > 0 ? rows[index - 1] : null;
    case "right": {
      const dir = dirName(rows[index].path);
      for (let i = index + 1; i < rows.length; i++) {
        if (dirName(rows[i].path) !== dir) return rows[i];
      }
      return null; // already in the last group
    }
    case "left": {
      const dir = dirName(rows[index].path);
      let i = index - 1;
      while (i >= 0 && dirName(rows[i].path) === dir) i--;
      if (i < 0) return null; // already in the first group
      const prevDir = dirName(rows[i].path);
      while (i > 0 && dirName(rows[i - 1].path) === prevDir) i--;
      return rows[i];
    }
  }
}
