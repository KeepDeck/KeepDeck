import type { MouseEvent } from "react";

/**
 * Takes one thing off a row — detach an artifact, drop a label, delete a
 * row, remove a list entry: a small text ×. Its own control, never the
 * shared CloseButton: the header's close glyph means "close this surface"
 * and must not come to mean "remove this thing". Always present, never
 * revealed on hover — a control only a pointer can uncover is out of a
 * Tab's reach.
 */
export function RemoveButton({
  label,
  onClick,
  size = "md",
}: {
  /** Tooltip and accessible name — "Remove <what>". */
  label: string;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  /** `md` (default): a row's. `sm`: inside a tag. */
  size?: "md" | "sm";
}) {
  return (
    <button
      type="button"
      className={size === "sm" ? "ui-remove ui-remove--sm" : "ui-remove"}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}
