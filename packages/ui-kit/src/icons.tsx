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

/** Git branch — identifies the currently observed branch in pane chrome
 * (Lucide `git-branch`, ISC). */
export function GitBranchIcon() {
  return (
    <svg {...iconProps}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1 -9 9" />
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

/** Keyboard — the "send input to this process" toggle on the run log
 * (Lucide `keyboard`, ISC), simplified to stay legible at 13px. */
export function KeyboardIcon() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01" />
      <path d="M8 14h8" />
    </svg>
  );
}

/** Two curved arrows chasing each other — the universal refresh/rescan glyph
 * (Feather `refresh-cw`, MIT). */
export function RefreshIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
