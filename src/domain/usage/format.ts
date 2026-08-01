import type { UsageStatsPeriod } from "./history";
import { windowExpired, type AccountUsage, type UsageWindow } from "./usage";

/**
 * Presentation rules for usage data — pure, time-injected. The chips stay
 * calm by default: color appears only at the thresholds below.
 */

export type UsageLevel = "ok" | "warn" | "critical";

/** Account-window thresholds: amber at 60% used, red at 80. */
export function limitLevel(usedPct: number): UsageLevel {
  if (usedPct >= 80) return "critical";
  if (usedPct >= 60) return "warn";
  return "ok";
}

/** Context-window thresholds: amber at 75% (autocompact territory), red at 90. */
export function contextLevel(usedPct: number): UsageLevel {
  if (usedPct >= 90) return "critical";
  if (usedPct >= 75) return "warn";
  return "ok";
}

/** Account-wide windows for the CHIP: scoped windows stay in the panel,
 * shortest window first, at most `max` — the chip is a glance, not a
 * report. Product rules, so they live (and are tested) here, not in the
 * component. */
export function chipWindows(account: AccountUsage, max = 2): UsageWindow[] {
  if (account.kind !== "reported") return [];
  return [...account.windows]
    .filter((w) => w.scope === undefined)
    .sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))
    .slice(0, max);
}

/** Every window for the PANEL, scoped ones after account-wide. */
export function panelWindows(account: AccountUsage): UsageWindow[] {
  if (account.kind !== "reported") return [];
  return [...account.windows].sort(
    (a, b) =>
      Number(a.scope !== undefined) - Number(b.scope !== undefined) ||
      (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity),
  );
}

/** The label a window earns from its LENGTH — never from field position
 * (codex plans disagree about which window is primary). Unknown lengths
 * fall back to the scope name, else "plan" — the safety net for a window
 * whose duration no source reports. The chip abbreviates ("wk"/"mo"), the
 * panel has room to spell the word out ("week"/"month"). */
export function windowLabel(
  window: UsageWindow,
  form: "short" | "long" = "short",
): string {
  switch (window.windowMinutes) {
    case 300:
      return "5h";
    case 1440:
      return "day";
    case 10_080:
      return form === "long" ? "week" : "wk";
    case 43_200:
      return form === "long" ? "month" : "mo";
    default:
      return window.scope ?? "plan";
  }
}

/** "2h 10m" / "45m" — the short countdown a chip tooltip carries; minutes
 * round UP (a reset is never promised early). Null when the reset instant
 * is unknown or already passed. */
export function formatCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || resetsAt <= now) return null;
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "42%" or "58% left" — the user picks which direction the number runs;
 * threshold COLOR always follows % used regardless. Used rounds UP (the
 * CLIs' own /usage panels ceil; understating consumption reads as a bug —
 * field report: claude said 5%, a rounded chip said 4). */
export function formatPct(usedPct: number, display: "used" | "left"): string {
  const pct = Math.min(100, Math.ceil(usedPct));
  return display === "left" ? `${100 - pct}% left` : `${pct}%`;
}

/** How long a report stays trustworthy without a successor. Push data does
 * not age like polled data — windows only move when the account is USED —
 * but a reset passing (see `windowExpired`) or a very old report deserve a
 * visual demotion rather than confident color. */
export const USAGE_STALE_AFTER_MS = 30 * 60 * 1000;

export function usageStale(reportedAt: number, now: number): boolean {
  return now - reportedAt > USAGE_STALE_AFTER_MS;
}

/** The threshold color a window may WEAR — null means none: an expired
 * window's percentage describes the previous window, so it never carries
 * confident color, and an ok-level window stays calm. THE one home of the
 * expired-suppression rule; every surface (chip value, fill bar, provider
 * card) asks here instead of re-deriving it. */
export function windowLevel(
  window: UsageWindow,
  now: number,
): Exclude<UsageLevel, "ok"> | null {
  if (windowExpired(window, now)) return null;
  const level = limitLevel(window.usedPct);
  return level === "ok" ? null : level;
}

/** The caption under a window's percentage — the full window-kind semantics
 * in ONE place (its label sibling is [`windowLabel`]): a live countdown, a
 * rolling window whose reset the CLI didn't share, or a clockless plan BALANCE
 * (kimi's totalQuota — spent and topped up, never reset). An EXPIRED window
 * splits by surface, and both answers are deliberate: the chip popover
 * ("short") stays EMPTY — the dimmed percentage reads as stale and the extra
 * note was noise (field decision) — while the Stats card ("long") spells the
 * state out, because the gray bar alone read as a bug even to the tool's
 * author. */
export function windowResetCaption(
  window: UsageWindow,
  now: number,
  form: "short" | "long" = "short",
): string {
  if (windowExpired(window, now)) {
    return form === "long" ? "reset passed · % is from the previous window" : "";
  }
  const countdown = formatCountdown(window.resetsAt, now);
  if (countdown) return `resets in ${countdown}`;
  return window.windowMinutes !== null ? "reset unknown" : "plan allowance";
}

/** "now" / "3m ago" / "2h ago" — the popover's "Updated …" line. */
export function formatAge(reportedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - reportedAt) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** "Jul 22" / "Jul 22, 2026" — labeled in UTC because every stats day
 * bucket (recap, daily chart, milestone dates) is a UTC day; a local-time
 * label would drift off its own bucket. */
export function formatUtcDay(at: number, withYear = false): string {
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** The period switcher's order and labels — exhaustive by construction: a
 * new UsageStatsPeriod member fails to compile until it names itself, so a
 * period can never exist that the switcher silently omits or that renders
 * as an empty string inside the Highlights sentence. */
export const USAGE_PERIODS: readonly UsageStatsPeriod[] = [1, 7, 30, 90, "all"];

export const PERIOD_LABELS: Record<UsageStatsPeriod, string> = {
  1: "24h",
  7: "7d",
  30: "30d",
  90: "90d",
  all: "All",
};

/** The cost-provenance disclaimer under the Overview cards — the one text
 * in the app that distinguishes provider API estimates from subscription
 * charges, so it lives with the other money captions, not in a view. */
export function costCoverage(costSessions: number, sessionCount: number): string {
  if (costSessions === 0) {
    return "No CLI reported a cost estimate. Token totals remain available.";
  }
  if (costSessions === sessionCount) {
    return "Provider-reported API estimates, not subscription charges.";
  }
  return `Provider estimates available for ${costSessions} of ${sessionCount} sessions; unreported sessions are excluded.`;
}

/** Dollars, the ONE way: four decimals while sub-cent amounts would vanish,
 * cents while they matter, whole grouped dollars once they don't. `approx`
 * prefixes "≈" — provider costs are estimates, not invoices. */
export function formatUsd(value: number, opts: { approx?: boolean } = {}): string {
  const magnitude =
    value === 0
      ? "0.00"
      : value < 0.01
        ? value.toFixed(4)
        : value < 1_000
          ? value.toFixed(2)
          : Math.round(value).toLocaleString("en-US");
  return `${opts.approx === true ? "≈" : ""}$${magnitude}`;
}

/** A provider-cost aggregate: "—" until at least one event carried a cost —
 * zero-with-no-reports must never read as "free". */
export function displayProviderCost(value: number, costEvents: number): string {
  return costEvents === 0 ? "—" : formatUsd(value, { approx: true });
}

/** A token count as a compact, glanceable string: "812", "15.5k", "1.2M",
 * "5B", "1T". One decimal that a whole number drops ("15.0k" → "15k");
 * sub-thousand counts stay exact. Non-finite or ≤0 is "0". Every boundary
 * promotes at 999.95 of the lower unit so a value never renders as "1000k",
 * "1000M" or "1000B" — the T tier exists because the achievements ladder
 * already names a trillion. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const oneDp = (x: number) => {
    const v = Math.round(x * 10) / 10;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  const k = n / 1000;
  if (k < 999.95) return `${oneDp(k)}k`;
  const m = n / 1_000_000;
  if (m < 999.95) return `${oneDp(m)}M`;
  const b = n / 1_000_000_000;
  return b < 999.95 ? `${oneDp(b)}B` : `${oneDp(n / 1_000_000_000_000)}T`;
}
