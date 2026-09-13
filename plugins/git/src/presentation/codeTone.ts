import type { ChangeRow } from "../domain/status";

/**
 * The colour a row's code cell takes — the CSS modifier behind
 * `git__code--*`. The tone is the row's SECTION: it says which diff the
 * row opens (index-vs-HEAD green, worktree-vs-index amber, an untracked
 * file blue, a range diff neutral), and the section header already names
 * what happened. Two exceptions carry their own meaning in any section: a
 * conflict, and a deletion — the one change a reader must not mistake for
 * an edit. Renames and type changes are edits of their section on purpose.
 */
export type CodeTone = ChangeRow["kind"] | "del";

export function codeTone(row: ChangeRow): CodeTone {
  if (row.kind === "conflicted") return "conflicted";
  if (row.code === "D") return "del";
  return row.kind;
}
