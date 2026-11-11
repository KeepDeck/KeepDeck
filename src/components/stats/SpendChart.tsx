import { Bar, BarChart, BarStack, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CHART_BAR_RADIUS,
  CHART_CURSOR_FILL,
  CHART_HEIGHT,
  CHART_TEXT_SIZE,
  CHART_TICK_INK,
} from "../../domain/usage/chartPalette";
import type { CostStep } from "../../domain/usage/stats/fold";
import {
  spendTipView,
  stepValue,
  type SpendChartView,
  type SpendTipView,
} from "../../presentation/stats/spendChartView";

/**
 * Money over time, stacked by agent — wide flush columns with the stack's
 * cap rounded, a quiet value axis, the exact figures in the hover card.
 * Colours come from the roster-stable series palette; what the chart and
 * its card say is settled in presentation/stats/spendChartView.ts. Series
 * read through accessor functions, so an agent id can never collide with
 * an axis field or be misread as a lodash property path.
 */
export function SpendChart({ view }: { view: SpendChartView }) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={view.steps} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap="14%">
        <XAxis
          dataKey="start"
          tickFormatter={view.tick}
          tick={{ fill: CHART_TICK_INK, fontSize: CHART_TEXT_SIZE }}
          axisLine={false}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={view.axis}
          tick={{ fill: CHART_TICK_INK, fontSize: CHART_TEXT_SIZE }}
          axisLine={false}
          tickLine={false}
          width={52}
          tickCount={4}
        />
        <Tooltip
          cursor={{ fill: CHART_CURSOR_FILL }}
          isAnimationActive={false}
          wrapperStyle={{ zIndex: 1 }}
          // The hovered step is found by the x value recharts reports — its
          // own payload row is untyped.
          content={(props) => <StepTip tip={spendTipView(view, props.active === true, props.label)} />}
        />
        {/* The stack is rounded as ONE column — its cap's corners, whatever
            segment is on top. */}
        <BarStack radius={[CHART_BAR_RADIUS, CHART_BAR_RADIUS, 0, 0]}>
          {view.agents.map((agent) => (
            <Bar
              key={agent}
              name={agent}
              dataKey={(step: CostStep) => stepValue(step, agent)}
              fill={view.color(agent)}
              isAnimationActive={false}
            />
          ))}
        </BarStack>
      </BarChart>
    </ResponsiveContainer>
  );
}

function StepTip({ tip }: { tip: SpendTipView | null }) {
  if (!tip) return null;
  return (
    <div className="stats__chart-tip">
      <b>{tip.heading}</b>
      {tip.rows.map((row) => (
        <span className="stats__chart-tip-row" key={row.agent}>
          <span className="stats__chart-tip-name">
            <i style={{ background: row.color }} />
            {row.agent}
          </span>
          <span className="stats__chart-tip-total">{row.cost}</span>
        </span>
      ))}
      {tip.unpriced !== null && <small className="stats__chart-tip-note">{tip.unpriced}</small>}
    </div>
  );
}
