import type { MouseEvent } from "react";
import { CloseIcon } from "./icons";

/**
 * THE close button for a surface's header — one glyph (the shared stroke
 * [`CloseIcon`]), one size, one hover, always the header's right end. Panes,
 * the Settings/Skills dialogs and the transcript viewer all render this;
 * per-surface copies drifted (a text "×" here, its own padding there).
 * Row-level DELETE affordances (journal rows, the workspaces rail) are a
 * different idiom and keep their small text "×".
 */
export function CloseButton({
  label,
  onClick,
  className,
}: {
  /** Tooltip and accessible name — "Close <what>". */
  label: string;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  /** Extra class for surface-specific layout (never for restyling). */
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`ui-close${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <CloseIcon />
    </button>
  );
}
