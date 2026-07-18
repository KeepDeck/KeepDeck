import type { UsageWindow } from "./usage";

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

/** The label a window earns from its LENGTH — never from field position
 * (codex plans disagree about which window is primary). Unknown lengths
 * fall back to the scope name or a generic mark. */
export function windowLabel(window: UsageWindow): string {
  switch (window.windowMinutes) {
    case 300:
      return "5h";
    case 1440:
      return "day";
    case 10_080:
      return "wk";
    case 43_200:
      return "mo";
    default:
      return window.scope ?? "win";
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

/** "now" / "3m ago" / "2h ago" — the popover's "Updated …" line. */
export function formatAge(reportedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - reportedAt) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
