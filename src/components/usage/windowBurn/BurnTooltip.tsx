import { createPortal } from "react-dom";
import { CHART_ITEM_INK, CHART_LABEL_INK, CHART_TOOLTIP_BG, CHART_TOOLTIP_BORDER } from "../../../domain/usage/chartPalette";
import { useAnchoredTooltipPosition, type TooltipAnchorRect } from "../../../ui/tooltip/useAnchoredTooltipPosition";
import type { BurnTooltipView } from "../../../presentation/burnInspection";

/** The hover card of a burn plot — when, observed or projected, how much —
 * shared by every plot that inspects one. Portalled to the body, anchored
 * to the point it describes. */
export function BurnTooltip({
  id,
  getAnchorRect,
  view,
  stroke,
  ownerDocument,
}: {
  id: string;
  getAnchorRect(): TooltipAnchorRect | null;
  /** What it says (presentation/burnInspection.ts). */
  view: BurnTooltipView;
  stroke: string;
  ownerDocument: Document;
}) {
  const { tooltipRef, position } = useAnchoredTooltipPosition({
    ownerDocument,
    getAnchorRect,
  });

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="usage-burn-tooltip"
      data-kind={view.kind}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
        background: CHART_TOOLTIP_BG,
        borderColor: CHART_TOOLTIP_BORDER,
      }}
    >
      <span
        className="usage-burn-tooltip__label"
        style={{ color: CHART_LABEL_INK }}
      >
        {view.label}
      </span>
      <span
        className="usage-burn-tooltip__value"
        style={{ color: CHART_ITEM_INK }}
      >
        <i aria-hidden style={{ background: stroke }} />
        <span>{view.source}</span>
        <b>{view.value}</b>
      </span>
      {view.note && (
        <span className="usage-burn-tooltip__note" style={{ color: CHART_LABEL_INK }}>
          {view.note}
        </span>
      )}
    </div>,
    ownerDocument.body,
  );
}
