import { useEffect, useId, useRef, useState } from "react";
import { GitBranchIcon, RestoreUpIcon } from "../../ui/icons";
import type { GitBadge } from "../../ui/gitBadge";
import { MinimizedDetailsTooltip } from "./MinimizedDetailsTooltip";

export const MINIMIZED_TOOLTIP_DELAY_MS = 600;

interface MinimizedItemProps {
  /** `chip` = a compact pill for the tray; `bar` = a full-width header bar for
   * the strip. */
  variant: "chip" | "bar";
  title: string;
  /** The agent's live branch badge, when its cwd is a known git HEAD. */
  gitBadge?: GitBadge | null;
  /** Accessible action label for the whole control, e.g. "Restore Claude 1". */
  label: string;
  onClick(): void;
}

interface MinimizedItemContentProps {
  title: string;
  gitBadge?: GitBadge | null;
}

/** Shared visual payload for the live control and the tray's hidden sizer. */
export function MinimizedItemContent({
  title,
  gitBadge,
}: MinimizedItemContentProps) {
  return (
    <>
      <span className="minimized__title">{title}</span>
      {gitBadge && (
        <span className="minimized__branch" aria-hidden>
          <GitBranchIcon />
          <span className="minimized__branch-label">{gitBadge.label}</span>
        </span>
      )}
      <span className="minimized__restore" aria-hidden>
        <RestoreUpIcon />
      </span>
    </>
  );
}

/**
 * The stand-in a minimized agent shows below the grid — a tray chip or a folded
 * strip bar. It carries no terminal; the real pane is hidden but still mounted
 * in the grid, so restoring is instant (no re-attach, no scrollback replay).
 */
export function MinimizedItem({
  variant,
  title,
  gitBadge,
  label,
  onClick,
}: MinimizedItemProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const focused = useRef(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLElement | null>(null);
  const tooltipId = useId();

  const cancelHover = () => {
    if (hoverTimer.current === null) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const closeTooltip = () => {
    cancelHover();
    setTooltipAnchor(null);
  };
  const openTooltip = () => {
    cancelHover();
    setTooltipAnchor(buttonRef.current);
  };
  useEffect(() => cancelHover, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`minimized minimized--${variant}`}
        onMouseEnter={() => {
          cancelHover();
          hoverTimer.current = window.setTimeout(
            openTooltip,
            MINIMIZED_TOOLTIP_DELAY_MS,
          );
        }}
        onMouseLeave={() => {
          cancelHover();
          if (!focused.current) setTooltipAnchor(null);
        }}
        onFocus={() => {
          focused.current = true;
          openTooltip();
        }}
        onBlur={() => {
          focused.current = false;
          closeTooltip();
        }}
        onClick={() => {
          closeTooltip();
          onClick();
        }}
        aria-label={label}
        aria-describedby={tooltipAnchor ? tooltipId : undefined}
      >
        <MinimizedItemContent title={title} gitBadge={gitBadge} />
      </button>
      {tooltipAnchor && (
        <MinimizedDetailsTooltip
          anchor={tooltipAnchor}
          id={tooltipId}
          title={title}
          gitBadge={gitBadge}
        />
      )}
    </>
  );
}
