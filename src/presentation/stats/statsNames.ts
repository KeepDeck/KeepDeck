import { modelLabel } from "../../domain/usage";
import { modelProvider } from "../../domain/usage/history/event";
import type { BreakdownRow } from "../../domain/usage/stats/fold";
import { rowTeam, type TeamHistory } from "../../domain/usage/stats/teams";

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

/** Team groups by the team's name, its workspace beside it — a name is only
 * unique inside one — and whether the team was inferred rather than
 * recorded, read off the group's newest row. */
export function teamName(row: BreakdownRow, teams: TeamHistory): GroupName {
  if (row.folded > 0) return foldedName(row);
  const team = rowTeam(row.latest, teams);
  const inferred = team.source === "journal" || team.source === "branch";
  return {
    name: team.name ?? "Team unknown",
    source: [row.latest.workspaceName, inferred ? "inferred" : null].filter(Boolean).join(" · "),
  };
}

/** Agent groups by the agent's id — the name every stats surface uses. */
export function agentName(row: BreakdownRow): GroupName {
  return row.folded > 0 ? foldedName(row) : { name: row.latest.agent, source: null };
}

/** A session id short enough for a table cell: an id longer than twelve
 * characters keeps its first eight and an ellipsis, a short one stays whole,
 * and a missing one says so. */
export function shortSession(sessionId: string | undefined): string {
  if (!sessionId) return "Unknown session";
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

/** Session groups by the pane they ran in, else the session's id; the
 * source says where and by which agent. */
export function sessionName(row: BreakdownRow): GroupName {
  if (row.folded > 0) return foldedName(row);
  const { latest } = row;
  return {
    name: latest.paneName || shortSession(latest.sessionId),
    source: [latest.workspaceName, latest.agent].filter(Boolean).join(" · "),
  };
}
