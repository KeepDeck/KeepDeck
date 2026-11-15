import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { BurnGeometry } from "../../../domain/usage/windowBurn";
import {
  inspectedSample,
  NO_INSPECTION,
  steppedInspection,
  type BurnInspectionSample,
  type BurnInspectionState,
} from "../../../presentation/burnInspection";

/** The client point a pointer-driven tooltip anchors to. */
export interface PointerAnchor {
  x: number;
  y: number;
}

/**
 * The inspection state of one burn plot — pointer, arrow keys, focus — and
 * the events that move it. It holds state only: which point that state
 * shows, and where a key takes it, are presentation/burnInspection.ts.
 */
export function useBurnInspection(geometry: BurnGeometry): {
  sample: BurnInspectionSample | null;
  /** Where the pointer is, while it drives the inspection. */
  anchor: PointerAnchor | null;
  handlers: {
    onMouseMove(event: MouseEvent<HTMLElement>): void;
    onMouseLeave(): void;
    onFocus(): void;
    onBlur(): void;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  };
} {
  const [state, setState] = useState<BurnInspectionState>(NO_INSPECTION);
  const [anchor, setAnchor] = useState<PointerAnchor | null>(null);
  return {
    sample: inspectedSample(geometry, state),
    anchor: state.pointerX === null ? null : anchor,
    handlers: {
      onMouseMove(event) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const pointerX = (event.clientX - rect.left) / rect.width;
        setState((current) => ({ ...current, pointerX }));
        setAnchor({ x: event.clientX, y: event.clientY });
      },
      onMouseLeave() {
        setState((current) => ({ ...current, pointerX: null }));
      },
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
