import { useMemo, useState } from "react";
import { displayProviderCost, formatTokens } from "../../domain/usage";
import {
  ledgerSeriesColors,
  seriesColorFor,
} from "../../domain/usage/chartPalette";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import {
  formatWeekLabel,
  usageWeeks,
  WEEK_IN_PROGRESS,
  weekAwaitingUsage,
  weekDeltaCaption,
  weekProgressCaption,
  type UsageWeek,
} from "../../domain/usage/weeks";
import { Tooltip } from "../../ui/Tooltip";

/** Rows per page — the block's height is CONSTANT however much history
 * accumulates; older weeks live behind the pager, never behind growth or
 * an inner scrollbar (user decision). */
const WEEKS_PAGE = 8;

/** Completed calendar weeks at the bottom of Overview. Period-independent
 * on purpose: the block runs on its own clock (UTC weeks) and stays
 * visible whatever range the switcher selects — the Providers precedent.
 * The bar reads as a lying-down bar chart: length is the week's size
 * against the largest week, segments are the agents that burned it, in
 * the same series colors as the chart above — which also LEGENDS them,
 * so this block adds none; the hover names each share exactly. */
export function Weeks({
  events,
  now,
}: {
  events: readonly UsageEventV2[];
  now: number;
}) {
  const weeks = useMemo(() => usageWeeks(events, now), [events, now]);
  const colors = useMemo(() => ledgerSeriesColors(events), [events]);
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
      <h3>Weeks</h3>
      <div className="stats__table" role="table" aria-label="Weeks">
        {slice.map((week) => (
          <div className="stats__row stats__week-row" role="row" key={week.start}>
            <span className="stats__week-label" role="cell">
              <b>{formatWeekLabel(week.start, now)}</b>
            </span>
            {weekAwaitingUsage(week) ? (
              // An honest empty-state LINE, not a zero-and-dash husk. The
              // in-progress fact lives in the line — never as a tag that
              // would break the one-line rhythm or widen the label column.
              <span className="stats__week-none" role="cell">
                {WEEK_IN_PROGRESS}
              </span>
            ) : (
              <>
                <span className="stats__week-tokens" role="cell">
                  {formatTokens(week.totalTokens)}
                </span>
                <span className="stats__week-barcell" role="cell">
                  {week.totalTokens > 0 && (
                    <WeekBar week={week} colors={colors} max={max} now={now} />
                  )}
                  {/* The rest of the week, drawn as room rather than as
                      absence: without it a short bar reads as a quiet week
                      instead of an unfinished one. */}
                  {week.current && <span className="stats__week-rest" />}
                </span>
                <span
                  className={
                    week.current ? "stats__week-progress" : "stats__week-delta"
                  }
                  role="cell"
                >
                  {week.current
                    ? weekProgressCaption(week.start, now)
                    : weekDeltaCaption(week.deltaPct)}
                </span>
                <span className="stats__week-model" role="cell">
                  {week.topModel ? (
                    <>
                      {/* The NAME ellipsizes; the count never does — a
                          long model name must not eat its own number. */}
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
              </>
            )}
          </div>
        ))}
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

/** One week's bar with its hover card — both read the SAME domain
 * segments, so the bar and the tip that explains it cannot disagree. */
function WeekBar({
  week,
  colors,
  max,
  now,
}: {
  week: UsageWeek;
  colors: ReadonlyMap<string, string>;
  max: number;
  now: number;
}) {
  return (
    <Tooltip
      focusable
      style={{
        width: `${Math.max(2, Math.round((week.totalTokens / max) * 100))}%`,
      }}
      tip={
        <span className="stats__week-tip">
          <b>{formatWeekLabel(week.start, now)}</b>
          {week.segments.map((segment) => (
            <span key={segment.agent}>
              <i style={{ background: seriesColorFor(colors, segment.agent) }} />
              {segment.agent} · {formatTokens(segment.totalTokens)}
            </span>
          ))}
        </span>
      }
    >
      <span className="stats__week-bar">
        {week.segments.map((segment) => (
          <i
            key={segment.agent}
            style={{
              flexGrow: segment.totalTokens,
              background: seriesColorFor(colors, segment.agent),
            }}
          />
        ))}
      </span>
    </Tooltip>
  );
}
