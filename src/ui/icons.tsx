/**
 * The app's stroke-icon set: tiny inline SVGs on the shared 24-unit grid,
 * drawn with the current text color so buttons tint them via CSS. Icon-only
 * buttons must carry their own `title`/`aria-label` — the icons are
 * decorative (`aria-hidden`).
 */

const iconProps = {
  viewBox: "0 0 24 24",
  width: 13,
  height: 13,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Expand-to-fill (enter fullscreen). */
export function MaximizeIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Restore / un-maximize — the conventional minimize glyph (a bottom bar),
 * clearly distinct from the expand arrows and easy to read. */
export function RestoreIcon() {
  return (
    <svg {...iconProps}>
      <line x1="6" y1="18" x2="18" y2="18" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...iconProps}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** Run — the conventional play triangle (run presets). */
export function PlayIcon() {
  return (
    <svg {...iconProps}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

/** Arrow driving into the next fixed slot — "use the next available one"
 * (Lucide `arrow-right-to-line`, ISC). */
export function NextIcon() {
  return (
    <svg {...iconProps}>
      <path d="M17 12H3" />
      <path d="m11 18 6-6-6-6" />
      <path d="M21 5v14" />
    </svg>
  );
}

/** Two plug halves closing the gap — attach to something already running,
 * the dev-tool attach/connect idiom (Tabler `plug-connected`, MIT). */
export function AttachIcon() {
  return (
    <svg {...iconProps}>
      <path d="M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5" />
      <path d="M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5" />
      <path d="M3 21l2.5 -2.5" />
      <path d="M18.5 5.5l2.5 -2.5" />
      <path d="M10 11l-2 2" />
      <path d="M13 14l-2 2" />
    </svg>
  );
}
