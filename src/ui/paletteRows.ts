import { fuzzyFilterBy } from "@keepdeck/ui-kit/Combobox";
import type { ReactNode } from "react";

/** One row a palette offers: what a pick hands back, what it reads, the
 * quiet word at its end, and what stands before it (a status ring). */
export interface PaletteItem {
  value: string;
  label: string;
  hint?: string;
  leading?: ReactNode;
}

export interface PaletteSection {
  title: string;
  items: readonly PaletteItem[];
}

/** A line of the windowed list: a section's heading, or a row with its
 * place among the rows (what the arrows count). */
export type PaletteRow =
  | { kind: "section"; key: string; title: string }
  | { kind: "item"; key: string; item: PaletteItem; at: number };

/**
 * What a palette shows for `query` — its rule, pure: every section's rows
 * that match (fuzzy, by a row's words and its hint), a section with none
 * left dropped, as ONE list of headings and rows for the window, each row
 * numbered across every section; and how many rows there are.
 */
export function paletteRows(sections: readonly PaletteSection[], query: string): { rows: PaletteRow[]; count: number } {
  const rows: PaletteRow[] = [];
  let at = 0;
  for (const section of sections) {
    const items = fuzzyFilterBy(section.items, query, (item) => `${item.label} ${item.hint ?? ""}`);
    if (items.length === 0) continue;
    rows.push({ kind: "section", key: `section:${section.title}`, title: section.title });
    for (const item of items) rows.push({ kind: "item", key: `item:${item.value}`, item, at: at++ });
  }
  return { rows, count: at };
}

/** The highlighted row after an arrow: one step, round the ends. */
export function stepCursor(cursor: number, count: number, step: 1 | -1): number {
  return count === 0 ? 0 : (cursor + step + count) % count;
}

/** The highlight kept on a row that is there — the list narrows under it
 * as the person types. */
export function clampCursor(cursor: number, count: number): number {
  return Math.min(cursor, Math.max(count - 1, 0));
}
