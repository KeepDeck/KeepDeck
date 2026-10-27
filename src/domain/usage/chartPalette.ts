/**
 * The usage chart's chrome — its size and its inks. The series colours are
 * presentation/usagePalette.ts's, keyed on the agent catalog.
 */

/** The chart's plot height; the Suspense placeholder builds the same box
 * from this constant so the overview cannot jump when the chunk lands. */
export const CHART_HEIGHT = 240;

/** The stack's rounded cap, in px — half the chrome's mark radius
 * (`--kd-radius-mark`): a column is a few px wide, and the mark's 4px
 * domed it. recharts clamps it to half the column's width and height, so
 * the hourly view's narrowest columns and a 1–2px stack still round as far
 * as they can — expected. tokens.test.ts holds the relation. */
export const CHART_BAR_RADIUS = 2;

/* Chart CHROME — grid, axes, inks, tooltip surfaces. Beside the series
 * palette so a design pass finds every chart color in ONE module. SVG props
 * cannot read CSS custom properties, so each is the value of a token in
 * tokens.css, and tokens.test.ts holds it there. */
export const CHART_TICK_INK = "#55555c";
export const CHART_LEGEND_INK = "#7e7e87";
/** The chart's text size, in px — the chrome's small step (tokens.css),
 * for the tick labels and the legend alike. */
export const CHART_TEXT_SIZE = 11;
export const CHART_ITEM_INK = "#a6a6ae";
export const CHART_LABEL_INK = "#55555c";
export const CHART_TOOLTIP_BG = "#161618";
export const CHART_TOOLTIP_BORDER = "#2a2a2f";
export const CHART_CURSOR_FILL = "rgba(255, 255, 255, 0.04)";
