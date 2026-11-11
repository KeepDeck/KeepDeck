import { formatCountdown, type UsageWindow } from "../../domain/usage";
import { seriesColorFor } from "../usagePalette";
import type { ProviderCardView, ProvidersView, ToneText } from "./providersView";

/**
 * The Overview's glance at the limits: every provider window as one line —
 * bar, percent, time to reset — read off the Limits tab's own cards, so the
 * two can never disagree. The forecast speaks here only when it WARNS, and
 * a stale reading says so: a quiet low percent must never read as safe
 * when it is old or rising fast. The curve and the full captions stay on
 * Limits.
 */

export interface GlanceWindowView {
  id: string;
  /** The provider's name, on its first window's line only. */
  agent: string | null;
  label: string;
  percent: ToneText;
  expired: boolean;
  /** For the shared window bar, which colours itself. */
  window: UsageWindow;
  /** Time left to the reset, "reset" once it passed, empty when unknown. */
  reset: string;
  /** The forecast's warning, when it has one. */
  alarm: ToneText | null;
}

export interface GlanceProviderView {
  agent: string;
  color: string;
  windows: GlanceWindowView[];
  /** The report age, only when it is old enough to doubt. */
  stale: ToneText | null;
}

export interface LimitsGlanceView {
  title: string;
  /** The door to the Limits tab. */
  link: string;
  providers: GlanceProviderView[];
  /** Said instead when no provider has reported. */
  empty: string | null;
}

export function limitsGlanceView(
  view: ProvidersView,
  now: number,
  colors: ReadonlyMap<string, string>,
): LimitsGlanceView {
  const head = { title: "Limits now", link: "Limits →" };
  if (view.kind === "empty") return { ...head, providers: [], empty: "No provider reports yet." };
  return { ...head, providers: view.cards.map((card) => glanceProvider(card, now, colors)), empty: null };
}

function glanceProvider(card: ProviderCardView, now: number, colors: ReadonlyMap<string, string>): GlanceProviderView {
  return {
    agent: card.agent,
    color: seriesColorFor(colors, card.agent),
    windows: card.windows.map((window, index) => {
      // Only a caption part with a level is a warning; the reset clause and
      // a calm forecast carry none.
      const alarm = window.caption.find((part) => part.className !== undefined);
      return {
        id: window.id,
        agent: index === 0 ? card.agent : null,
        label: window.label,
        percent: window.percent,
        expired: window.expired,
        window: window.window,
        reset: window.expired ? "reset" : (formatCountdown(window.window.resetsAt, now) ?? ""),
        alarm: alarm === undefined ? null : { text: alarm.text, className: alarm.className },
      };
    }),
    stale: card.updated.className === undefined ? null : card.updated,
  };
}
