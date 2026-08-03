import { useMemo, useState } from "react";
import { displayProviderCost, formatTokens } from "../../domain/usage";
import {
  agentSeriesColors,
  seriesColorFor,
} from "../../domain/usage/chartPalette";
import { usageAgents } from "../../domain/usage/daily";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import {
  formatWeekLabel,
  usageWeeks,
  weekDeltaCaption,
} from "../../domain/usage/weeks";

/** Rows per page — the block's height is CONSTANT however much history
 * accumulates; older weeks live behind the pager, never behind growth or
 * an inner scrollbar (user decision). */
const WEEKS_PAGE = 8;

/** Completed calendar weeks at the bottom of Overview. Period-independent
 * on purpose: the block runs on its own clock (UTC weeks) and stays
 * visible whatever range the switcher selects — the Providers precedent.
 * The bar reads as a lying-down bar chart: length is the week's size
 * against the largest week, segments are the agents that burned it, in
 * the same series colors as the chart above. */
export function Weeks({
  events,
  now,
}: {
  events: readonly UsageEventV2[];
  now: number;
}) {
  const weeks = useMemo(() => usageWeeks(events, now), [events, now]);
  // The ledger-roster palette — the same contract as the chart and the
  // provider cards, so a week's segments and the daily bars above never
  // disagree on a hue.
  const roster = useMemo(() => usageAgents(events), [events]);
  const colors = useMemo(() => agentSeriesColors(roster), [roster]);
  const [page, setPage] = useState(0);
  if (weeks.length === 0) return null;

  const pages = Math.ceil(weeks.length / WEEKS_PAGE);
  // The ledger only grows, but clamp anyway — a stale page must show the
  // last page, not an empty one.
  const shown = Math.min(page, pages - 1);
  const from = shown * WEEKS_PAGE;
  const slice = weeks.slice(from, from + WEEKS_PAGE);
  const max = Math.max(...weeks.map((week) => week.totalTokens));

  return (
    <section className="stats__section stats__weeks">
      <h3>
        Weeks
        <span className="stats__weeks-legend">
          {roster.map((agent) => (
            <span key={agent}>
              <i style={{ background: seriesColorFor(colors, agent) }} />
              {agent}
            </span>
          ))}
        </span>
      </h3>
      <div className="stats__table" role="table" aria-label="Weeks">
        {slice.map((week) => {
          // A week in progress with nothing burned yet gets an honest
          // empty-state LINE (the "no usage this window" vocabulary), not
          // a zero-and-dash husk that reads as table furniture.
          if (week.current && week.totalTokens === 0) {
            return (
              <div
                className="stats__week-row stats__week-row--current"
                role="row"
                key={week.start}
              >
                <span className="stats__week-label" role="cell">
                  <b>{formatWeekLabel(week.start, now)}</b>
                  <small>in progress</small>
                </span>
                <span className="stats__week-none" role="cell">
                  no usage yet — fills in live as agents report
                </span>
              </div>
            );
          }
          return (
          <div
            className={`stats__week-row${week.current ? " stats__week-row--current" : ""}`}
            role="row"
            key={week.start}
          >
            <span className="stats__week-label" role="cell">
              {/* The tag stacks UNDER the date (the stats__identity idiom)
                  so the widest row cannot widen the label column for all. */}
              <b>{formatWeekLabel(week.start, now)}</b>
              {week.current && <small>in progress</small>}
            </span>
            <span className="stats__week-tokens" role="cell">
              {formatTokens(week.totalTokens)}
            </span>
            <span className="stats__week-barcell" role="cell">
              {week.totalTokens > 0 && (
                <span
                  className="stats__week-bar"
                  style={{
                    width: `${Math.max(2, Math.round((week.totalTokens / max) * 100))}%`,
                  }}
                >
                  {roster
                    .filter((agent) => (week.byAgent.get(agent) ?? 0) > 0)
                    .map((agent) => (
                      <i
                        key={agent}
                        style={{
                          flexGrow: week.byAgent.get(agent),
                          background: seriesColorFor(colors, agent),
                        }}
                      />
                    ))}
                </span>
              )}
            </span>
            <span className="stats__week-delta" role="cell">
              {weekDeltaCaption(week.deltaPct)}
            </span>
            <span className="stats__week-model" role="cell">
              {week.topModel ? (
                <>
                  {/* The NAME ellipsizes; the count never does — a long
                      model name must not eat its own number. */}
                  <span className="stats__week-model-name">
                    {week.topModel.model}
                  </span>
                  <span>· {formatTokens(week.topModel.totalTokens)}</span>
                </>
              ) : (
                "—"
              )}
            </span>
            <span className="stats__week-cost" role="cell">
              {displayProviderCost(week.providerCostUsd, week.costEvents)}
            </span>
          </div>
          );
        })}
      </div>
      {pages > 1 && (
        <div className="stats__weeks-pager">
          <button
            type="button"
            disabled={shown === 0}
            onClick={() => setPage(shown - 1)}
            aria-label="Newer weeks"
          >
            ‹
          </button>
          <span>
            {from + 1}–{from + slice.length} of {weeks.length}
          </span>
          <button
            type="button"
            disabled={from + WEEKS_PAGE >= weeks.length}
            onClick={() => setPage(shown + 1)}
            aria-label="Older weeks"
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}
