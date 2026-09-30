import { noAutoCorrect } from "./inputProps";
import type { InlineRename } from "./useInlineRename";

interface RenameInputProps {
  /** The rename in progress — its draft and its commit/cancel keys. */
  rename: InlineRename;
  /** The site's own class — its size and place in the row. The field's
   * look is `.rename-input`'s (rename.css), the same everywhere. */
  className: string;
  /** What a screen reader calls the field. */
  label: string;
  /** Keep presses inside the field from reaching a clickable parent (a
   * card whose click opens it). */
  contained?: boolean;
}

/** The field an inline rename edits in: focused on mount, no autocorrect,
 * committing and cancelling as `useInlineRename` says. One markup for every
 * surface that renames something in place. */
export function RenameInput({ rename, className, label, contained }: RenameInputProps) {
  const stop = contained ? (event: { stopPropagation(): void }) => event.stopPropagation() : undefined;
  return (
    <input
      {...noAutoCorrect}
      {...rename.inputProps}
      className={`rename-input ${className}`}
      autoFocus
      aria-label={label}
      onMouseDown={stop}
      onClick={stop}
    />
  );
}
