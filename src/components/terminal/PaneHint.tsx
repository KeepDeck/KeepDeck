import { useLayoutEffect, useRef } from "react";
import { positionHint } from "../../ui/hintPosition";

/** How long an in-pane hint stays up before it fades ([F16]). */
export const HINT_MS = 2000;

/** A hint message anchored at the pane-local point that was clicked. */
export interface PaneHint {
  text: string;
  x: number;
  y: number;
}

/**
 * Transient notice over a terminal surface ([F16]/[U8]) — "⌘-click to open",
 * "File not found" — shared by every xterm host (agent panes, the Run log).
 * Renders as a positioned sibling of the xterm host inside a
 * `position: relative` box, next to the clicked point. Positioned once its
 * size is measurable — before paint, so it never flashes at the wrong spot;
 * re-runs per show (each hint is a fresh object).
 */
export function PaneHintView({ hint }: { hint: PaneHint | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.parentElement;
    if (!el || !pane || !hint) return;
    const pos = positionHint(
      hint,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: pane.clientWidth, height: pane.clientHeight },
    );
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  }, [hint]);

  if (!hint) return null;
  return (
    <div className="pane-hint" role="status" ref={ref}>
      {hint.text}
    </div>
  );
}
