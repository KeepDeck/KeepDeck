import { modelLabel } from "../../domain/usage";
import { modelProvider } from "../../domain/usage/history/event";
import type { BreakdownRow } from "../../domain/usage/stats/fold";

/**
 * What a breakdown group is called. Read off the group's newest row; the
 * domain hands over keys and rows, never names.
 */

/** A group's name and, when the name alone would be ambiguous, where it
 * comes from — shown quietly beside it. */
export interface GroupName {
  name: string;
  source: string | null;
}

/** The "N more" row that closes a long list. */
export function foldedName(row: Pick<BreakdownRow, "folded">): GroupName {
  return { name: `${row.folded} more`, source: null };
}

/**
 * Model groups by the catalogue's name. Two groups can share one — two
 * providers serving the same model, or one model under two CLIs — and only
 * then does each name carry its provider (else its agent), so a list never
 * shows two identical lines.
 */
export function modelNames(rows: readonly BreakdownRow[]): Map<string, GroupName> {
  const nameOf = (row: BreakdownRow) => modelLabel(row.latest.model, row.latest.modelName);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.folded > 0) continue;
    counts.set(nameOf(row), (counts.get(nameOf(row)) ?? 0) + 1);
  }
  return new Map(
    rows.map((row) => {
      if (row.folded > 0) return [row.key, foldedName(row)];
      const name = nameOf(row);
      const twin = (counts.get(name) ?? 0) > 1;
      return [row.key, { name, source: twin ? (modelProvider(row.latest) ?? row.latest.agent) : null }];
    }),
  );
}

/** Workspace groups by the workspace's name. */
export function workspaceName(row: BreakdownRow): GroupName {
  return row.folded > 0 ? foldedName(row) : { name: row.latest.workspaceName, source: null };
}

/** Agent groups by the agent's id — the name every stats surface uses. */
export function agentName(row: BreakdownRow): GroupName {
  return row.folded > 0 ? foldedName(row) : { name: row.latest.agent, source: null };
}
