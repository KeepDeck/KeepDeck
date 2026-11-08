import { useMemo, useState } from "react";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import { usageWeeks } from "../../domain/usage/weeks";
import {
  weeksPageView,
  type WeekBarView,
  type WeeksPagerStep,
} from "../../presentation/stats/weeksView";
import { Tooltip } from "../../ui/Tooltip";

/** Completed calendar weeks at the bottom of Overview. Period-independent
 * on purpose: the block runs on its own clock (UTC weeks) and stays
 * visible whatever range the switcher selects — the Providers precedent.
 * The bar reads as a lying-down bar chart: length is the week's size
 * against the largest week, segments are the agents that burned it, in
 * the same series colors as the chart above — which also LEGENDS them,
 * so this block adds none; the hover names each share exactly. What every
 * row says is settled in presentation/stats/weeksView.ts. */
export function Weeks({
  ledger,
  colors,
  now,
}: {
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  /** The dialog's series colours (presentation/usagePalette.ts). */
  colors: ReadonlyMap<string, string>;
  now: number;
}) {
  const weeks = useMemo(() => usageWeeks(ledger.events, now), [ledger, now]);
  const [page, setPage] = useState(0);
  const view = weeksPageView(weeks, page, now, colors);
  if (!view) return null;

  return (
    <section className="stats__section stats__weeks">
      <h3>{view.title}</h3>
      <div className="stats__table" role="table" aria-label={view.title}>
        {view.rows.map((row) => (
          <div className="stats__row stats__week-row" role="row" key={row.start}>
            <span className="stats__week-label" role="cell">
              <b>{row.label}</b>
            </span>
            {row.kind === "awaiting" ? (
              // The in-progress fact lives in the line — never as a tag that
              // would break the one-line rhythm or widen the label column.
              <span className="stats__week-none" role="cell">
                {row.line}
              </span>
            ) : (
              <>
                <span className="stats__week-tokens" role="cell">
                  {row.tokens}
                </span>
                <span className="stats__week-barcell" role="cell">
                  {row.bar && <WeekBar bar={row.bar} />}
                  {row.rest && <span className="stats__week-rest" />}
                </span>
                <span className={`stats__week-${row.trend.kind}`} role="cell">
                  {row.trend.text}
                </span>
                <span className="stats__week-model" role="cell">
                  {row.model.kind === "model" ? (
                    <>
                      {/* The NAME ellipsizes; the count never does — a
                          long model name must not eat its own number. */}
                      <span className="stats__week-model-name">{row.model.name}</span>
                      <span>{row.model.count}</span>
                    </>
                  ) : (
                    row.model.text
                  )}
                </span>
                <span className="stats__week-cost" role="cell">
                  {row.cost}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {view.pager && (
        <div className="stats__weeks-pager">
          <PagerButton step={view.pager.newer} onPage={setPage} />
          <span>{view.pager.range}</span>
          <PagerButton step={view.pager.older} onPage={setPage} />
        </div>
      )}
    </section>
  );
}

function PagerButton({ step, onPage }: { step: WeeksPagerStep; onPage: (page: number) => void }) {
  const to = step.to;
  return (
    <button
      type="button"
      disabled={to === null}
      onClick={() => {
        if (to !== null) onPage(to);
      }}
      aria-label={step.label}
    >
      {step.glyph}
    </button>
  );
}

/** One week's bar with its hover card — both read the SAME segments, so
 * the bar and the tip that explains it cannot disagree. */
function WeekBar({ bar }: { bar: WeekBarView }) {
  return (
    <Tooltip
      focusable
      style={{ width: `${bar.widthPct}%` }}
      tip={
        <span className="stats__week-tip">
          <b>{bar.label}</b>
          {bar.segments.map((segment) => (
            <span key={segment.agent}>
              <i style={{ background: segment.color }} />
              {segment.caption}
            </span>
          ))}
        </span>
      }
    >
      <span className="stats__week-bar">
        {bar.segments.map((segment) => (
          <i
            key={segment.agent}
            style={{ flexGrow: segment.tokens, background: segment.color }}
          />
        ))}
      </span>
    </Tooltip>
  );
}
