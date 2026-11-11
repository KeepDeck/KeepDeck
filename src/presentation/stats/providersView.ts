import { formatPct, windowLabel, windowLevel, type UsageWindow } from "../../domain/usage";
import type { ProviderWindowGroup } from "../../domain/usage/providerWindows";
import { windowBurn, type BurnGeometry } from "../../domain/usage/windowBurn";
import { burnEdgeLabel, cardCaptionParts, type BurnEdge } from "../../domain/usage/windowForecast";
import { seriesColorFor } from "../usagePalette";
import { reportedAgeCaption, usageLevelClass } from "../usageView";
import { displayCost, windowLedgerCaption } from "./statsCost";
import { sessionName } from "./statsNames";

/**
 * The Limits tab's provider cards, settled: one card per provider with its report age
 * once, a note when a window has reset, and each window's reading, bar,
 * burn and captions. The component renders this and decides nothing.
 */

/** A piece of text and the class that colours it, if any. */
export interface ToneText {
  text: string;
  className?: string;
}

export interface ProviderWindowView {
  id: string;
  label: string;
  percent: ToneText;
  expired: boolean;
  /** For the shared window bar, which colours itself. */
  window: UsageWindow;
  /** None while the window has no reports to draw. */
  burn: BurnGeometry | null;
  stroke: string;
  edge: BurnEdge;
  /** The card's caption, in order, each part joined to the last by " · ". */
  caption: (ToneText & { lead: string })[];
  /** What this machine spent inside the window, when it can be said. */
  ledger: string | null;
  /** Which sessions spent it, the biggest first. */
  sessions: { key: string; name: string; source: string | null; cost: string }[];
}

export interface ProviderCardView {
  agent: string;
  updated: ToneText;
  /** Said once per card whenever ANY window has reset — not only when they
   * all have: a card with a live weekly window and an expired 5h one would
   * otherwise show a dimmed percentage with nothing saying it describes a
   * window that is gone. */
  note: string | null;
  windows: ProviderWindowView[];
}

export type ProvidersView =
  | { kind: "empty"; text: string }
  | { kind: "cards"; title: string; cards: ProviderCardView[] };

const tone = (text: string, className: string | undefined): ToneText =>
  className ? { text, className } : { text };

function windowView(
  row: ProviderWindowGroup["rows"][number],
  now: number,
  colors: ReadonlyMap<string, string>,
): ProviderWindowView {
  return {
    id: row.id,
    label: windowLabel(row.window, "long"),
    percent: tone(formatPct(row.window.usedPct, "used"), usageLevelClass(windowLevel(row.window, now))),
    expired: row.expired,
    window: row.window,
    burn: windowBurn(row.reports, row.window, row.forecast, now, "limit"),
    stroke: seriesColorFor(colors, row.agent),
    edge: burnEdgeLabel(row.window, row.forecast, now),
    caption: cardCaptionParts(row.window, row.forecast, now).map((part, index) => ({
      ...tone(part.text, usageLevelClass(part.level)),
      lead: index > 0 ? " · " : "",
    })),
    ledger: row.ledger ? windowLedgerCaption(row.ledger) : null,
    sessions: (row.ledger?.sessions ?? []).map((session) => ({
      key: session.key,
      ...sessionName(session),
      cost: displayCost(session),
    })),
  };
}

export function providersView(
  groups: readonly ProviderWindowGroup[],
  now: number,
  colors: ReadonlyMap<string, string>,
): ProvidersView {
  if (groups.length === 0) {
    return {
      kind: "empty",
      text: "No provider reports yet. Windows appear once a CLI reports its account limits.",
    };
  }
  return {
    kind: "cards",
    title: "Providers",
    cards: groups.map((group) => ({
      agent: group.agent,
      updated: tone(reportedAgeCaption(group.reportedAt, now), usageLevelClass(group.stale ? "warn" : null)),
      note: group.rows.some((row) => row.expired)
        ? "A window that has reset keeps showing the previous window's percentage until this account reports again."
        : null,
      windows: group.rows.map((row) => windowView(row, now, colors)),
    })),
  };
}
