/**
 * The stroke-icon subset the Run panel needs: tiny inline SVGs on the shared
 * 24-unit grid, drawn with the current text color so buttons tint them via CSS.
 * Icon-only buttons carry their own `title`/`aria-label` — the icons are
 * decorative (`aria-hidden`).
 *
 * Vendored from the host's src/ui/icons because a built-in plugin bundles
 * standalone (it can't import host src/), and this stage adds no new npm deps.
 * The classNames/styling they render into come from the host stylesheet — the
 * builtin-tier rule.
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

export function CloseIcon() {
  return (
    <svg {...iconProps}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** Collapse-direction chevron (dropdown state). */
export function ChevronDownIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** Edit — the conventional pencil (Lucide `pencil`, ISC). */
export function EditIcon() {
  return (
    <svg {...iconProps}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
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

/** Filled play — a state glyph's ACTION face (run/run-again on hover). */
export function PlayFillIcon() {
  return (
    <svg {...iconProps} fill="currentColor" strokeWidth={0} width={11} height={11}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

/** Filled stop square — the running glyph's ACTION face. */
export function StopFillIcon() {
  return (
    <svg {...iconProps} fill="currentColor" strokeWidth={0} width={10} height={10}>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}
