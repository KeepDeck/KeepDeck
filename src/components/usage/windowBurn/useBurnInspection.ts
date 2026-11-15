import { useCallback, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import {
  inspectedSample,
  NO_INSPECTION,
  steppedInspection,
  type BurnInspectionGeometry,
  type BurnInspectionSample,
  type BurnInspectionState,
} from "../../../presentation/burnInspection";
import type { TooltipAnchorRect } from "../../../ui/tooltip/useAnchoredTooltipPosition";
import { useScrollExit } from "../../../ui/tooltip/useScrollExit";

/**
 * The inspection of one burn plot — pointer, arrow keys, focus — the events
 * that move it, and where its hover card anchors: at the pointer while the
 * pointer drives it, else at the inspected point on the plot. It holds
 * state and measures the element; which point the state shows, and where a
 * key takes it, are presentation/burnInspection.ts.
 */
export function useBurnInspection(
  geometry: BurnInspectionGeometry,
  plot: {
    ref: RefObject<HTMLElement | null>;
    /** How far down the plot a sample sits, 0 (top) to 1 (bottom). */
    depth(sample: BurnInspectionSample): number;
  },
): {
  sample: BurnInspectionSample | null;
  getAnchorRect: (() => TooltipAnchorRect | null) | null;
  handlers: {
    onMouseMove(event: MouseEvent<HTMLElement>): void;
    onMouseLeave(): void;
    onFocus(): void;
    onBlur(): void;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  };
} {
  const [state, setState] = useState<BurnInspectionState>(NO_INSPECTION);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const sample = inspectedSample(geometry, state);
  const anchor = state.pointerX === null ? null : pointer;
  // The pointer leaving — off the plot, or the plot scrolled out from under
  // it (useScrollExit) — ends the pointer's inspection; the keys' and
  // focus's stay, and follow the plot.
  const pointerLeft = useCallback(() => setState((current) => ({ ...current, pointerX: null })), []);
  useScrollExit(state.pointerX !== null, plot.ref, pointerLeft);
  return {
    sample,
    getAnchorRect:
      sample === null
        ? null
        : anchor !== null
          ? () => ({ top: anchor.y, bottom: anchor.y, left: anchor.x })
          : () => {
              const rect = plot.ref.current?.getBoundingClientRect();
              if (rect === undefined) return null;
              const top = rect.top + plot.depth(sample) * rect.height;
              return { top, bottom: top, left: rect.left + sample.x * rect.width };
            },
    handlers: {
      onMouseMove(event) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const pointerX = (event.clientX - rect.left) / rect.width;
        setState((current) => ({ ...current, pointerX }));
        setPointer({ x: event.clientX, y: event.clientY });
      },
      onMouseLeave: pointerLeft,
      onFocus() {
        setState((current) => ({ ...current, focused: true }));
      },
      onBlur() {
        setState((current) => ({ ...current, focused: false, keyedX: null }));
      },
      onKeyDown(event) {
        if (event.key === "Escape") {
          setState(NO_INSPECTION);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        setState((current) => ({ ...current, keyedX: steppedInspection(geometry, current, direction) }));
      },
    },
  };
}
