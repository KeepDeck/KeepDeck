import { visibleRows, type TreeState } from "./tree";

/**
 * Keyboard navigation over the VISIBLE tree — the standard ARIA tree model,
 * kept pure so it is testable without React or focus. Given the current tree,
 * the focused row (`cursor`), and an arrow, it returns where the cursor lands
 * plus any expand/collapse the host should apply. It never mutates the tree
 * itself: expand/collapse are returned as intents (the hook owns the async
 * load), so this stays a pure function of `(state, cursor, key)`.
 *
 * - Down / Up: move to the next / previous visible row (clamped at the ends).
 * - Right on a collapsed directory: expand it (cursor stays). On an expanded
 *   directory: step into its first child. On a file: nothing.
 * - Left on an expanded directory: collapse it. Otherwise: jump to the parent
 *   row. A top-level row has no parent to jump to.
 * - With no cursor yet, any arrow focuses the first row.
 */
export type ArrowKey = "up" | "down" | "left" | "right";

export interface NavAction {
  /** Where the cursor should be after the key (may equal the input cursor). */
  cursor: string | null;
  /** A directory the host should expand (Right on a collapsed directory). */
  expand?: string;
  /** A directory the host should collapse (Left on an expanded directory). */
  collapse?: string;
}

export function navigate(
  state: TreeState,
  cursor: string | null,
  key: ArrowKey,
): NavAction {
  const rows = visibleRows(state);
  if (rows.length === 0) return { cursor };

  const index = rows.findIndex((row) => row.node.path === cursor);
  // No cursor (or it scrolled out of the tree): any arrow lands on the first row.
  if (index < 0) return { cursor: rows[0].node.path };

  const current = rows[index];
  switch (key) {
    case "down":
      return { cursor: rows[Math.min(index + 1, rows.length - 1)].node.path };
    case "up":
      return { cursor: rows[Math.max(index - 1, 0)].node.path };
    case "right":
      if (current.node.kind === "dir") {
        if (!current.node.expanded) {
          return { cursor, expand: current.node.path };
        }
        // Expanded and loaded → its first child follows immediately at depth+1.
        const child = rows[index + 1];
        if (child && child.depth === current.depth + 1) {
          return { cursor: child.node.path };
        }
      }
      return { cursor };
    case "left":
      if (current.node.kind === "dir" && current.node.expanded) {
        return { cursor, collapse: current.node.path };
      }
      // Jump to the parent: the nearest preceding row one level shallower.
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth === current.depth - 1) {
          return { cursor: rows[i].node.path };
        }
      }
      return { cursor };
  }
}
