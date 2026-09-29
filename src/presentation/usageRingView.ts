import type { UsageDisplay } from "../domain/settings";
import {
  chipWindows,
  formatAge,
  formatPct,
  tightestWindow,
  usageStale,
  windowLabel,
  windowLevel,
  type AccountUsage,
  type UsageLevel,
  type UsageWindow,
} from "../domain/usage";

/** One subscription's ring in the top bar, settled — the component maps it. */
export interface UsageRingView {
  /** How full the ring is drawn, 0–100: the tightest window's use. */
  fill: number;
  /** The window the ring and its number speak for, or null while waiting
   * for the first report. */
  window: UsageWindow | null;
  /** Colour only near the limit; null while calm or expired. */
  level: Exclude<UsageLevel, "ok"> | null;
  stale: boolean;
  /** Every chip window, spelled out — the ring shows one number, the hover
   * gives the rest. */
  title: string;
}

export function usageRingView(
  label: string,
  account: AccountUsage | undefined,
  now: number,
  display: UsageDisplay,
): UsageRingView {
  const window = account ? tightestWindow(account, now) : null;
  const stale = account !== undefined && usageStale(account.reportedAt, now);
  const windows = account ? chipWindows(account) : [];
  const readings = windows.map((w) => `${windowLabel(w)} ${formatPct(w.usedPct, display)}`).join(" · ");
  return {
    fill: window ? Math.min(100, Math.max(0, window.usedPct)) : 0,
    window,
    level: window ? windowLevel(window, now) : null,
    stale,
    title: !account
      ? `${label}: waiting for the first report`
      : stale
        ? `${label}: showing data from ${formatAge(account.reportedAt, now)}${readings ? ` — ${readings}` : ""}`
        : `${label}${readings ? ` · ${readings}` : ""}`,
  };
}
