/**
 * Tree-specific stroke icons, on the SAME 24-unit grid as `@keepdeck/ui-kit`'s
 * set (drawn in the current text color, decorative/`aria-hidden`) so the Files
 * tab reads as native chrome. Kept local rather than pushed into ui-kit: only
 * this plugin needs folder/file/symlink glyphs today.
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

/** A closed folder (Lucide `folder`, ISC). */
export function FolderIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
    </svg>
  );
}

/** A document with a folded corner (Lucide `file`, ISC). */
export function FileIcon() {
  return (
    <svg {...iconProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** A symlink — the "leads elsewhere" arrow (a link-out glyph). The target is
 * deliberately never resolved, so it reads as a pointer, not a real folder. */
export function SymlinkIcon() {
  return (
    <svg {...iconProps}>
      <path d="M7 17 17 7" />
      <polyline points="8 7 17 7 17 16" />
    </svg>
  );
}

/** Toggle soft-wrapping of long code lines (Lucide `wrap-text`, ISC). */
export function WrapIcon() {
  return (
    <svg {...iconProps}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
      <polyline points="16 16 14 18 16 20" />
      <line x1="3" y1="18" x2="10" y2="18" />
    </svg>
  );
}

/** Open in the default app — an arrow leaving a frame (Lucide
 * `external-link`, ISC). */
export function OpenExternalIcon() {
  return (
    <svg {...iconProps}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
