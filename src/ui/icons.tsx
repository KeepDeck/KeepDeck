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

/** Skip forward (chevrons) — "use the next available one". */
export function NextIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="5 6 11 12 5 18" />
      <polyline points="13 6 19 12 13 18" />
    </svg>
  );
}

/** Chain link — attach to something that already exists. */
export function AttachIcon() {
  return (
    <svg {...iconProps}>
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}
