/**
 * An agent's brand mark, rendered from bare SVG path data (the catalog icon
 * a cli plugin contributes). Filled artwork, unlike the stroke-icon set —
 * brand marks come as solid shapes on their own grid. Decorative like the
 * stroke set: the adjacent text or the control's aria-label names the agent.
 * Sized `1em` so it rides the surrounding font; tint comes from the mark's
 * own brand color or, for monochrome marks, the current text color — which
 * is what lets one artwork read on both dark chrome and hover states.
 */

/** Structural shape of a renderable mark — matches both the plugin contract's
 * and the domain's `AgentIcon` without importing either. */
export interface AgentGlyphIcon {
  viewBox: string;
  path: string;
  color?: string;
  fillRule?: "evenodd";
}

export function AgentGlyph({
  icon,
  className,
}: {
  /** No mark (plugin absent or icon-less) falls back to a neutral prompt. */
  icon?: AgentGlyphIcon | null;
  className?: string;
}) {
  if (!icon) {
    // A terminal prompt — an honest "some CLI", never borrowed branding.
    return (
      <svg
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="5 6 11 12 5 18" />
        <line x1="13" y1="18" x2="19" y2="18" />
      </svg>
    );
  }
  return (
    <svg
      viewBox={icon.viewBox}
      width="1em"
      height="1em"
      className={className}
      fill={icon.color ?? "currentColor"}
      fillRule={icon.fillRule}
      aria-hidden
    >
      <path d={icon.path} />
    </svg>
  );
}
