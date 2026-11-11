import { formatAge, formatTokens, formatUtcDay } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { dimensionKey, type StatsDimension } from "../../domain/usage/stats/dimensions";
import { earliestOccurredAt } from "../../domain/usage/history/ledger";
import { breakdown, rowsIn, rowsOf, statsTotals, type BreakdownRow } from "../../domain/usage/stats/fold";
import { statsSpans, type StatsPeriod } from "../../domain/usage/stats/period";
import { seriesColorFor } from "../usagePalette";
import { changeView, type ChangeView } from "./overviewView";
import { costCoverage, displayCost } from "./statsCost";
import type { SessionClaimKey } from "../../domain/deck";
import type { TeamHistory } from "../../domain/usage/stats/teams";
import { agentName, modelNames, sessionName, teamName, workspaceName, type GroupName } from "./statsNames";

/**
 * The Breakdown tab, settled: one table, any dimension, each group against
 * the same group in the days just before; a group opens into its sessions.
 * The component renders the rows and emits the reader's picks.
 */

/** How the table is ordered: by money, or by how much it moved. */
export type BreakdownOrder = "cost" | "change";

/** Exhaustive: a new dimension names itself or fails to compile. */
export const DIMENSION_LABELS: Record<StatsDimension, string> = {
  workspace: "Workspace",
  team: "Team",
  agent: "Agent",
  model: "Model",
  session: "Session",
};
const DIMENSIONS: readonly StatsDimension[] = ["workspace", "team", "agent", "model", "session"];

/** Said under team groups: history booked before teams were recorded has
 * its teams inferred, and the rows say so. */
const TEAM_NOTE =
  "Teams of usage booked before teams were recorded are inferred from the session journal or the worktree branch, and marked so.";
const ORDER_LABELS: Record<BreakdownOrder, string> = { cost: "By cost", change: "By change" };

/** How many groups the table names before folding the rest, and how many
 * sessions an opened group lists. */
export const BREAKDOWN_TOP = 8;
export const SESSIONS_TOP = 3;

export interface BreakdownRowView extends GroupName {
  key: string;
  /** The bar's length, relative to the widest group's share, 0–1. */
  width: number;
  shareText: string;
  /** The bar, split by agent — weights, not widths. */
  split: { agent: string; color: string; weight: number }[];
  cost: string;
  /** Null under a session of an opened group and on the closing row. */
  change: ChangeView | null;
  /** Said when there is no change to show for a group that could have one. */
  noChange: string | null;
  output: string;
  last: string;
  folded: boolean;
  /** A session a pane still holds: the door to that pane. */
  reveal: { session: SessionClaimKey; label: string } | null;
  /** Whether the row opens into its sessions, whether it is open, and
   * which group is open once it is clicked — none, if it was this one. */
  opens: boolean;
  open: boolean;
  toggle: string | null;
  sessions: BreakdownRowView[];
}

/** One row of choices: what it picks, and each choice. */
export interface ChoicesView<T extends string> {
  label: string;
  items: { id: T; label: string; active: boolean }[];
}

export interface BreakdownView {
  dimensions: ChoicesView<StatsDimension>;
  orders: ChoicesView<BreakdownOrder>;
  columns: { name: string; share: string; cost: string; change: string; output: string; last: string };
  rows: BreakdownRowView[];
  notes: string[];
}

export function breakdownView(
  rows: readonly UsageRow[],
  input: {
    period: StatsPeriod;
    now: number;
    dimension: StatsDimension;
    order: BreakdownOrder;
    /** The group the reader opened, if any. */
    open: string | null;
    colors: ReadonlyMap<string, string>;
    perModelSince: number | null;
    /** What the session journal says about teams. */
    teams: TeamHistory;
    /** The workspace the reader narrowed to, or null for every one. */
    workspace: string | null;
    /** Whether a pane still holds a session. */
    held(session: SessionClaimKey): boolean;
  },
): BreakdownView {
  const { period, now, dimension, order, open, colors, teams } = input;
  const scoped = rowsOf(rows, input.workspace);
  const spans = statsSpans(period, now);
  const current = rowsIn(scoped, spans.current);
  const prior = spans.prior === null ? [] : rowsIn(scoped, spans.prior);
  const keyOf = (row: UsageRow) => dimensionKey(dimension, row, teams);
  const groups = sortGroups(breakdown(current, prior, keyOf, BREAKDOWN_TOP), order);
  const names = nameGroups(dimension, groups, teams);
  const widest = Math.max(...groups.filter((group) => group.folded === 0).map((group) => group.share), 1e-9);
  const rowView = (group: BreakdownRow, nameOf: (group: BreakdownRow) => GroupName, child: boolean): BreakdownRowView => {
    const opens = !child && dimension !== "session" && group.folded === 0;
    const isOpen = opens && group.key === open;
    const comparable = !child && group.folded === 0 && spans.prior !== null;
    // A session row — of the session dimension or under an opened group —
    // opens its pane while a pane still holds it.
    const session = (child || dimension === "session") && group.folded === 0
      ? { agent: group.latest.agent, sessionId: group.latest.sessionId }
      : null;
    return {
      key: group.key,
      ...nameOf(group),
      width: group.folded > 0 ? 0 : group.share / widest,
      shareText: `${Math.round(group.share * 100)}%`,
      split: Object.keys(group.byAgent)
        .sort()
        .map((agent) => ({ agent, color: seriesColorFor(colors, agent), weight: group.byAgent[agent] ?? 0 })),
      cost: displayCost(group),
      change: comparable && group.change !== null ? changeView(group.change) : null,
      noChange: comparable && group.change === null ? "—" : null,
      output: formatTokens(group.outputTokens),
      last: group.folded > 0 ? "" : formatAge(group.latest.occurredAt, now),
      folded: group.folded > 0,
      reveal: session !== null && input.held(session) ? { session, label: "Open ↗" } : null,
      opens,
      open: isOpen,
      toggle: isOpen ? null : group.key,
      sessions: isOpen
        ? breakdown(current.filter((row) => keyOf(row) === group.key), [], (row) => dimensionKey("session", row), SESSIONS_TOP)
            .map((session) => rowView(session, sessionName, true))
        : [],
    };
  };
  const totals = statsTotals(current);
  const modelNote = dimension === "model" ? perModelNote(input.perModelSince, earliestOccurredAt(current)) : null;
  return {
    dimensions: {
      label: "Group by",
      items: DIMENSIONS.map((id) => ({ id, label: DIMENSION_LABELS[id], active: id === dimension })),
    },
    orders: {
      label: "Order",
      items: (["cost", "change"] as const).map((id) => ({ id, label: ORDER_LABELS[id], active: id === order })),
    },
    columns: {
      name: dimension === "session" ? "Session" : `${DIMENSION_LABELS[dimension]} ▸ Session`,
      share: "Share",
      cost: "Cost",
      change: "vs before",
      output: "Output",
      last: "Last",
    },
    rows: groups.map((group) => rowView(group, (row) => names.get(row.key) ?? { name: row.key, source: null }, false)),
    notes: [
      costCoverage(totals),
      ...(modelNote === null ? [] : [modelNote]),
      ...(dimension === "team" ? [TEAM_NOTE] : []),
    ],
  };
}

/** The note under the model groups when the period reaches back past the
 * ledger's switch to booking per model, or null when it does not: rows on
 * either side of it name models differently, so one model can be listed
 * twice. */
export function perModelNote(perModelSince: number | null, firstOccurredAt: number | null): string | null {
  if (perModelSince === null || firstOccurredAt === null) return null;
  if (firstOccurredAt >= perModelSince) return null;
  return (
    `Since ${formatUtcDay(perModelSince, true)}, an agent that reports each model's own ` +
    "tokens is listed by model id, and a session's cost under the model it ran on. " +
    "Earlier usage keeps the model names shown at the time."
  );
}

/** By cost is the fold's own order; by change ranks the biggest rise first,
 * groups with no change after them — the closing row stays last either way. */
function sortGroups(groups: BreakdownRow[], order: BreakdownOrder): BreakdownRow[] {
  if (order === "cost") return groups;
  const head = groups.filter((group) => group.folded === 0);
  const tail = groups.filter((group) => group.folded > 0);
  const rank = (group: BreakdownRow) => group.change ?? -Infinity;
  return [...head.sort((left, right) => rank(right) - rank(left)), ...tail];
}

function nameGroups(
  dimension: StatsDimension,
  groups: readonly BreakdownRow[],
  teams: TeamHistory,
): Map<string, GroupName> {
  if (dimension === "model") return modelNames(groups);
  const nameOf = {
    workspace: workspaceName,
    team: (group: BreakdownRow) => teamName(group, teams),
    agent: agentName,
    session: sessionName,
  }[dimension];
  return new Map(groups.map((group) => [group.key, nameOf(group)]));
}

