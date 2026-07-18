import { useEffect, useId, useRef, useState } from "react";
import { GitBranchIcon, RestoreUpIcon } from "../../ui/icons";
import type { GitBadge } from "../../ui/gitBadge";
import { AgentGlyph, type AgentGlyphIcon } from "../../ui/AgentGlyph";
import { MinimizedDetailsTooltip } from "./MinimizedDetailsTooltip";

export const MINIMIZED_TOOLTIP_DELAY_MS = 600;

interface MinimizedItemProps {
  /** `chip` = a compact pill for the tray; `bar` = a full-width header bar for
   * the strip. */
  variant: "chip" | "bar";
  title: string;
  /** The agent's brand mark; absent/null draws the neutral fallback. */
  icon?: AgentGlyphIcon | null;
  /** The agent's live branch badge, when its cwd is a known git HEAD. */
  gitBadge?: GitBadge | null;
  /** The pane runs in YOLO mode — the header chip's warning must survive
   * minimizing, so the stand-in carries a ⚡ marker too. */
  yolo?: boolean;
  /** Accessible action label for the whole control, e.g. "Restore Claude 1". */
  label: string;
  /** False while the source workspace is mounted but inactive. */
  active: boolean;
  onClick(): void;
}

interface MinimizedItemContentProps {
  title: string;
  /** The agent's brand mark; absent/null draws the neutral fallback. */
  icon?: AgentGlyphIcon | null;
  gitBadge?: GitBadge | null;
  yolo?: boolean;
}

/** Shared visual payload for the live control and the tray's hidden sizer. */
export function MinimizedItemContent({
  title,
  icon,
  gitBadge,
  yolo,
}: MinimizedItemContentProps) {
  return (
    <>
      <span className="minimized__agent" aria-hidden>
        <AgentGlyph icon={icon} />
      </span>
      <span className="minimized__title">{title}</span>
      {yolo && (
        <span
          className="minimized__yolo"
          title="YOLO mode — runs without permission prompts"
        >
          ⚡
        </span>
      )}
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
  icon,
  gitBadge,
  yolo,
  label,
  active,
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
  useEffect(() => {
    if (!active) closeTooltip();
  }, [active]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`minimized minimized--${variant}`}
        onMouseEnter={() => {
          if (!active) return;
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
          if (active) openTooltip();
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
        aria-describedby={active && tooltipAnchor ? tooltipId : undefined}
      >
        <MinimizedItemContent
          title={title}
          icon={icon}
          gitBadge={gitBadge}
          yolo={yolo}
        />
      </button>
      {active && tooltipAnchor && (
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
