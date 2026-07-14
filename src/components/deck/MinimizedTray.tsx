import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { GitBadge } from "../../ui/gitBadge";
import { MinimizedItem, MinimizedItemContent } from "./MinimizedItem";

export const MINIMIZED_TRAY_ITEM_MAX_WIDTH = 272;
export const MINIMIZED_TRAY_GAP = 8;
export const MINIMIZED_TRAY_OVERFLOW_WIDTH = 48;

const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;
const POPOVER_MAX_HEIGHT = 320;
const POPOVER_MIN_WIDTH = 160;

export interface MinimizedTrayEntry {
  id: string;
  title: string;
  gitBadge?: GitBadge | null;
  label: string;
  onRestore(): void;
}

/** How many direct restore items fit while reserving a final +N control. */
export function visibleTrayItemCount(
  availableWidth: number,
  naturalWidths: readonly number[],
): number {
  const widths = naturalWidths.map((width) =>
    Math.max(0, Math.min(MINIMIZED_TRAY_ITEM_MAX_WIDTH, width)),
  );
  if (widths.length === 0) return 0;
  const allItemsWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, widths.length - 1) * MINIMIZED_TRAY_GAP;
  if (allItemsWidth <= availableWidth) return widths.length;

  // The overflow control sits after the visible items, so every direct item
  // also needs the gap that separates it from its following sibling.
  let used = MINIMIZED_TRAY_OVERFLOW_WIDTH;
  let visible = 0;
  for (const width of widths) {
    const next = used + MINIMIZED_TRAY_GAP + width;
    if (next > availableWidth) break;
    used = next;
    visible += 1;
  }
  return Math.min(widths.length - 1, visible);
}

function sameWidths(left: readonly number[], right: readonly number[]) {
  return (
    left.length === right.length &&
    left.every((width, index) => width === right[index])
  );
}

interface PopoverPosition {
  top: number;
  left: number;
  maxHeight: number;
}

function popoverPosition(
  anchor: DOMRect,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  popoverWidth: number,
): PopoverPosition {
  const availableAbove = Math.max(
    0,
    anchor.top - POPOVER_MARGIN - POPOVER_GAP,
  );
  const availableBelow = Math.max(
    0,
    viewportHeight - POPOVER_MARGIN - anchor.bottom - POPOVER_GAP,
  );
  const above = availableAbove >= availableBelow;
  const maxHeight = Math.min(
    POPOVER_MAX_HEIGHT,
    above ? availableAbove : availableBelow,
  );
  const renderedHeight = Math.min(contentHeight, maxHeight);
  const left = Math.max(
    POPOVER_MARGIN,
    Math.min(
      anchor.right - popoverWidth,
      viewportWidth - popoverWidth - POPOVER_MARGIN,
    ),
  );

  return {
    top: above
      ? anchor.top - POPOVER_GAP - renderedHeight
      : anchor.bottom + POPOVER_GAP,
    left,
    maxHeight,
  };
}

function MinimizedOverflow({
  anchor,
  id,
  entries,
  popoverWidth,
  onClose,
}: {
  anchor: HTMLButtonElement;
  id: string;
  entries: MinimizedTrayEntry[];
  popoverWidth: number;
  onClose(): void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const recompute = useCallback(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const viewportWidth =
      document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight =
      document.documentElement.clientHeight || window.innerHeight;
    setPosition(
      popoverPosition(
        anchor.getBoundingClientRect(),
        Math.max(popover.scrollHeight, popover.getBoundingClientRect().height),
        viewportWidth,
        viewportHeight,
        popoverWidth,
      ),
    );
  }, [anchor, popoverWidth]);

  useLayoutEffect(() => {
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [recompute]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        anchor.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      anchor.focus();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      id={id}
      role="dialog"
      aria-label="Minimized agents"
      className="minimized-overflow"
      style={{
        width: popoverWidth,
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight ?? POPOVER_MAX_HEIGHT,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <div className="minimized-overflow__header">
        <span>Minimized agents</span>
        <span>{entries.length}</span>
      </div>
      <div className="minimized-overflow__list">
        {entries.map((entry) => (
          <MinimizedItem
            key={entry.id}
            variant="chip"
            title={entry.title}
            gitBadge={entry.gitBadge}
            label={entry.label}
            onClick={() => {
              onClose();
              entry.onRestore();
            }}
          />
        ))}
      </div>
    </div>,
    anchor.ownerDocument.body,
  );
}

/**
 * One fixed-height minimized-agent shelf. Direct restore targets keep pane
 * order; if they do not all fit, the last slot becomes an explicit +N control
 * whose popover exposes the complete minimized set without growing the deck.
 */
export function MinimizedTray({ entries }: { entries: MinimizedTrayEntry[] }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const overflowRef = useRef<HTMLButtonElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const [itemWidths, setItemWidths] = useState<number[]>([]);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const popoverId = useId();

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const sizer = sizerRef.current;
    if (!viewport || !sizer) return;
    const measure = () => {
      setAvailableWidth(viewport.getBoundingClientRect().width);
      const measured = Array.from(sizer.children).map((child) => {
        const width = child.getBoundingClientRect().width;
        return width > 0
          ? Math.min(MINIMIZED_TRAY_ITEM_MAX_WIDTH, width)
          : MINIMIZED_TRAY_ITEM_MAX_WIDTH;
      });
      setItemWidths((current) =>
        sameWidths(current, measured) ? current : measured,
      );
    };
    measure();
    const observer = window.ResizeObserver
      ? new window.ResizeObserver(measure)
      : null;
    observer?.observe(viewport);
    observer?.observe(sizer);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [entries]);

  const resolvedWidths =
    itemWidths.length === entries.length
      ? itemWidths
      : entries.map(() => MINIMIZED_TRAY_ITEM_MAX_WIDTH);

  const visibleCount =
    availableWidth === null
      ? entries.length
      : visibleTrayItemCount(availableWidth, resolvedWidths);
  const visibleEntries = entries.slice(0, visibleCount);
  const hiddenCount = entries.length - visibleCount;
  const popoverWidth = Math.max(
    POPOVER_MIN_WIDTH,
    Math.max(0, ...resolvedWidths) + 16,
  );
  const closeOverflow = useCallback(() => setOverflowOpen(false), []);

  useEffect(() => {
    if (hiddenCount === 0) setOverflowOpen(false);
  }, [hiddenCount]);

  return (
    <div className="deck__tray">
      <span className="deck__tray-label">Minimized · {entries.length}</span>
      <div ref={sizerRef} className="deck__tray-sizer" aria-hidden>
        {entries.map((entry) => (
          <span
            key={entry.id}
            className="minimized minimized--chip minimized--measure"
          >
            <MinimizedItemContent
              title={entry.title}
              gitBadge={entry.gitBadge}
            />
          </span>
        ))}
      </div>
      <div ref={viewportRef} className="deck__tray-items">
        {visibleEntries.map((entry) => (
          <MinimizedItem
            key={entry.id}
            variant="chip"
            title={entry.title}
            gitBadge={entry.gitBadge}
            label={entry.label}
            onClick={entry.onRestore}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            ref={overflowRef}
            type="button"
            className="minimized-overflow__trigger"
            aria-label={`Show all ${entries.length} minimized agents`}
            aria-haspopup="dialog"
            aria-expanded={overflowOpen}
            aria-controls={overflowOpen ? popoverId : undefined}
            onClick={() => setOverflowOpen((open) => !open)}
          >
            +{hiddenCount}
          </button>
        )}
      </div>
      {overflowOpen && overflowRef.current && hiddenCount > 0 && (
        <MinimizedOverflow
          anchor={overflowRef.current}
          id={popoverId}
          entries={entries}
          popoverWidth={popoverWidth}
          onClose={closeOverflow}
        />
      )}
    </div>
  );
}
