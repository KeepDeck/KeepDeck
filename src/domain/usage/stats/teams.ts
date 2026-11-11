import type { JournalRecords } from "../../journal/sessionLog";
import { usageSessionKey, type UsageRow } from "../history/event";

/**
 * Which KeepDeck team a usage row belongs to — THE one chain, from the
 * surest source down:
 * - recorded: capture records the team the row was booked under, or that
 *   its pane was on NO team — a fact, never a gap to infer over;
 * - journal: the team the session journal bound the session to — the team
 *   at the session's LATEST binding, a name only;
 * - branch: the team the journal last saw on the row's worktree branch IN
 *   THE ROW'S OWN WORKSPACE, AT THE ROW'S TIME — branches are recycled by
 *   successive teams, and two workspaces (even two of one name) can each
 *   have a `feature/x`;
 * - unknown.
 * Only a row booked before teams were recorded is inferred at all; such
 * rows shrink as recorded ones take over.
 */

export type TeamSource = "recorded" | "journal" | "branch";

/** A row's team: a member of a named team, recorded or inferred; on no
 * team, recorded; or unknown. */
export type RowTeam =
  | { kind: "member"; name: string; source: TeamSource }
  | { kind: "none" }
  | { kind: "unknown" };

/** What the session journal says about teams, read once per journal change. */
export interface TeamHistory {
  /** By agent session, the team of its latest binding anywhere — null when
   * that binding was on no team. */
  bySession: ReadonlyMap<string, string | null>;
  /** Per workspace SLOT and worktree branch, the teams bound on it over
   * time, oldest first. */
  byBranch: ReadonlyMap<string, readonly { at: number; team: string }[]>;
  /** Each slot's current workspace name — a row's slot answers for it only
   * while the name still matches (slots are reused). */
  names: ReadonlyMap<string, string>;
}

export const NO_TEAM_HISTORY: TeamHistory = { bySession: new Map(), byBranch: new Map(), names: new Map() };

const branchKey = (wsId: string, branch: string) => `${wsId}\0${branch}`;

/**
 * The journal's teams. The journal keys its records by workspace SLOT, and
 * a row carries its slot AND its workspace's name: a branch is the slot's,
 * and the slot answers for a row only while its current name
 * (`workspaceNames`) is the row's — a slot reused by another workspace, or
 * renamed, finds nothing and falls to unknown rather than borrowing. Two
 * workspaces of one name are two slots, never one.
 */
export function teamHistory(journal: JournalRecords, workspaceNames: ReadonlyMap<string, string>): TeamHistory {
  const bySession = new Map<string, { at: number; team: string | null }>();
  const byBranch = new Map<string, { at: number; team: string }[]>();
  for (const [wsId, records] of Object.entries(journal)) {
    for (const record of records) {
      const at = Date.parse(record.boundAt);
      if (!Number.isFinite(at)) continue;
      // The latest binding answers, a binding on no team included.
      const key = usageSessionKey(record);
      const seen = bySession.get(key);
      if (seen === undefined || seen.at <= at) bySession.set(key, { at, team: record.team ?? null });
      if (record.team === undefined || record.branch === undefined) continue;
      const holders = byBranch.get(branchKey(wsId, record.branch)) ?? [];
      holders.push({ at, team: record.team });
      byBranch.set(branchKey(wsId, record.branch), holders);
    }
  }
  for (const holders of byBranch.values()) holders.sort((left, right) => left.at - right.at);
  return { bySession: new Map([...bySession].map(([key, seen]) => [key, seen.team])), byBranch, names: workspaceNames };
}

export function rowTeam(row: UsageRow, history: TeamHistory): RowTeam {
  if (row.team !== undefined) {
    return row.team.kind === "member" ? { kind: "member", name: row.team.name, source: "recorded" } : { kind: "none" };
  }
  const named = history.bySession.get(usageSessionKey(row));
  if (named !== undefined && named !== null) return { kind: "member", name: named, source: "journal" };
  // A session whose latest binding was on no team names none to infer.
  if (named === null) return { kind: "unknown" };
  const branch = row.worktree?.branch;
  const sameWorkspace = history.names.get(row.workspaceId) === row.workspaceName;
  const holder =
    branch === undefined || !sameWorkspace ? null : holderAt(history.byBranch.get(branchKey(row.workspaceId, branch)), row.occurredAt);
  if (holder !== null) return { kind: "member", name: holder, source: "branch" };
  return { kind: "unknown" };
}

/** The key of a row's team group: a team's name is only unique inside its
 * workspace, and "no team" and "unknown" are groups of their own there. */
export function teamKey(row: UsageRow, history: TeamHistory): string {
  const team = rowTeam(row, history);
  const which = team.kind === "member" ? `team\0${team.name}` : team.kind;
  return `${row.workspaceName}\0${which}`;
}

/** How a team group's money is attributed: wholly recorded, wholly
 * inferred, or a mix — read off EVERY row of the group, never one. */
export type TeamProvenance = "recorded" | "inferred" | "mixed";

export function teamProvenance(rows: readonly UsageRow[], history: TeamHistory): Map<string, TeamProvenance> {
  const out = new Map<string, TeamProvenance>();
  for (const row of rows) {
    const team = rowTeam(row, history);
    const here: TeamProvenance = team.kind === "member" && team.source !== "recorded" ? "inferred" : "recorded";
    const key = teamKey(row, history);
    const seen = out.get(key);
    out.set(key, seen === undefined || seen === here ? here : "mixed");
  }
  return out;
}

/** The team bound on a branch last before `at` — none before its first. */
function holderAt(holders: readonly { at: number; team: string }[] | undefined, at: number): string | null {
  let holder: string | null = null;
  for (const entry of holders ?? []) {
    if (entry.at > at) break;
    holder = entry.team;
  }
  return holder;
}
