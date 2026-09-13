import type { ChangeGroups, ChangeRow } from "../domain/status";

/**
 * What the Changes section lists — the view model behind its rows: each
 * section that has rows as a head with its count, then its rows, in the
 * order the tab shows them (conflicts first, untracked last). One flat
 * list, so it can be windowed like any other; a head knows whether it
 * follows another section, which is where the gap between sections goes.
 */
export type ChangesListItem =
  | { kind: "head"; key: string; label: string; count: number; first: boolean }
  | { kind: "row"; key: string; row: ChangeRow };

const SECTIONS: readonly [label: string, pick: (groups: ChangeGroups) => ChangeRow[]][] = [
  ["Conflicts", (g) => g.conflicted],
  ["Staged", (g) => g.staged],
  ["Changes", (g) => g.unstaged],
  ["Untracked", (g) => g.untracked],
];

export function changesList(groups: ChangeGroups): ChangesListItem[] {
  const items: ChangesListItem[] = [];
  for (const [label, pick] of SECTIONS) {
    const rows = pick(groups);
    if (rows.length === 0) continue;
    items.push({ kind: "head", key: `head:${label}`, label, count: rows.length, first: items.length === 0 });
    for (const row of rows) {
      // The same path can sit in two sections — the section is part of
      // the identity, as it is of the row's diff.
      items.push({ kind: "row", key: `${row.kind}:${row.path}`, row });
    }
  }
  return items;
}
