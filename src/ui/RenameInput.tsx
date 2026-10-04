import { useRef } from "react";
import { noAutoCorrect } from "./inputProps";
import type { InlineRename } from "./useInlineRename";
import { useGrowingField } from "./useGrowingField";

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
  /** A name that may wrap (a task's title): the field wraps and grows with
   * it, a line at a time, rather than scrolling one line sideways. Enter
   * still commits — a name holds no line break. */
  multiline?: boolean;
}

/** The field an inline rename edits in: focused on mount, no autocorrect,
 * committing and cancelling as `useInlineRename` says. One markup for every
 * surface that renames something in place. */
export function RenameInput({ rename, className, label, contained, multiline }: RenameInputProps) {
  const stop = contained ? (event: { stopPropagation(): void }) => event.stopPropagation() : undefined;
  if (multiline) return <MultilineRename rename={rename} className={className} label={label} stop={stop} />;
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

function MultilineRename({
  rename,
  className,
  label,
  stop,
}: {
  rename: InlineRename;
  className: string;
  label: string;
  stop: ((event: { stopPropagation(): void }) => void) | undefined;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useGrowingField(field, rename.inputProps.value);
  return (
    <textarea
      {...noAutoCorrect}
      {...rename.inputProps}
      ref={field}
      rows={1}
      className={`rename-input rename-input--multiline ${className}`}
      autoFocus
      aria-label={label}
      onMouseDown={stop}
      onClick={stop}
      onKeyDown={(event) => {
        // Enter commits; it is never a line break in a name.
        if (event.key === "Enter") event.preventDefault();
        rename.inputProps.onKeyDown(event);
      }}
    />
  );
}
