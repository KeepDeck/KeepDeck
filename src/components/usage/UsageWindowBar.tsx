import { windowLevel, type UsageWindow } from "../../domain/usage";
import { usageLevelClass } from "../../presentation/usageView";

/** The window fill bar — structural gray unless [`windowLevel`] grants a
 * threshold color (it never does for an expired window). Shared by the
 * top-bar popover panel and the Stats Providers cards so the two surfaces
 * cannot drift apart. */
export function UsageWindowBar({
  window,
  now,
}: {
  window: UsageWindow;
  now: number;
}) {
  return (
    <span className="usage-bar" aria-hidden>
      <i
        className={usageLevelClass(windowLevel(window, now))}
        style={{ width: `${Math.round(window.usedPct)}%` }}
      />
    </span>
  );
}
