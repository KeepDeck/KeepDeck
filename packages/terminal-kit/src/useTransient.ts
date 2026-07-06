import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A value that clears itself after `ms` — the pane's transient-hint surface
 * ([F16]; the [U8] ⌘-click affordance can reuse it). Showing again restarts
 * the countdown, so a hint that replaces another still gets its full display
 * time. The returned setter is stable, safe to close over in mount-once
 * effects.
 */
export function useTransient<T>(ms: number): [T | null, (value: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback(
    (next: T) => {
      setValue(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setValue(null);
      }, ms);
    },
    [ms],
  );

  // Don't let a pending countdown set state on an unmounted component.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return [value, show];
}
