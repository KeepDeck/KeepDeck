import type { UsageDisplay } from "../../domain/settings";
import {
  formatPct,
  windowExpired,
  windowLevel,
  type UsageWindow,
} from "../../domain/usage";
import { usageLevelClass } from "../../presentation/usageView";

/** A window's percentage, wearing its level color and the expired
 * demotion — shared by the chips and the panel rows. */
export function WindowValue({
  window,
  display,
  now,
}: {
  window: UsageWindow;
  display: UsageDisplay;
  now: number;
}) {
  const level = usageLevelClass(windowLevel(window, now));
  return (
    <span
      className={`usage-window__value${level ? ` ${level}` : ""}${
        windowExpired(window, now) ? " usage-window--expired" : ""
      }`}
    >
      {formatPct(window.usedPct, display)}
    </span>
  );
}
