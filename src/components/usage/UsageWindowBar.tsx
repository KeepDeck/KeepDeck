import { limitLevel, windowExpired, type UsageWindow } from "../../domain/usage";

/** The window fill bar — structural gray unless a threshold speaks, and an
 * expired window never wears threshold color (its percentage describes the
 * previous window). Shared by the top-bar popover panel and the Stats
 * Providers cards so the two surfaces cannot drift apart. */
export function UsageWindowBar({
  window,
  now,
}: {
  window: UsageWindow;
  now: number;
}) {
  const level = limitLevel(window.usedPct);
  return (
    <span className="usage-bar" aria-hidden>
      <i
        className={
          windowExpired(window, now) || level === "ok" ? "" : `usage-level--${level}`
        }
        style={{ width: `${Math.round(window.usedPct)}%` }}
      />
    </span>
  );
}
