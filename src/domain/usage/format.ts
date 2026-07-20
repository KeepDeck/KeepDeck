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

/** The caption under a window's percentage — the full window-kind semantics
 * in ONE place (its label sibling is [`windowLabel`]): a live countdown, a
 * rolling window whose reset the CLI didn't share, or a clockless plan BALANCE
 * (kimi's totalQuota — spent and topped up, never reset). An EXPIRED window
 * gets NO caption (empty): the dimmed percentage already reads as stale, so the
 * "awaiting report" note was just noise. */
export function windowResetCaption(window: UsageWindow, now: number): string {
  if (windowExpired(window, now)) return "";
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

/** A token count as a compact, glanceable string: "812", "15.5k", "1.2M".
 * One decimal that a whole number drops ("15.0k" → "15k"); sub-thousand
 * counts stay exact. Non-finite or ≤0 is "0". The k→M boundary promotes at
 * 999.95k so a value never renders as "1000k". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const oneDp = (x: number) => {
    const v = Math.round(x * 10) / 10;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  const k = n / 1000;
  return k < 999.95 ? `${oneDp(k)}k` : `${oneDp(n / 1_000_000)}M`;
}
