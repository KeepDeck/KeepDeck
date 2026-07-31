import { useState } from "react";

/** What `useInlineRename` hands the widget: the subject under edit (null =
 * not editing), plus the controlled-input wiring. Presentation (className,
 * aria-label, autoFocus, the no-autocorrect spread) stays the widget's.
 * Keys are plain strings — both consumers compare them against string ids,
 * and a type parameter here bought two annotations and nothing else. */
export interface InlineRename {
  /** The subject being edited, or null when the widget shows plain text. */
  editing: string | null;
  /** Enter edit mode on `key`, seeding the draft with the current name. */
  start(key: string, current: string): void;
  /** The editable input's behavior: controlled value, blur/Enter commit,
   * Escape cancels without committing. */
  inputProps: {
    value: string;
    onChange(event: { target: { value: string } }): void;
    onBlur(): void;
    onKeyDown(event: { key: string }): void;
  };
}

/**
 * One inline-rename behavior for every surface that has one ([F11]): the pane
 * header and the workspaces rail grew separate copies whose empty-input
 * semantics drifted apart (reset-to-auto vs silently-keep-old).
 *
 * The contract is committed here once: blur and Enter commit the TRIMMED
 * draft — an empty commit means "reset to the auto name", which the receiver
 * implements (both rename domain ops revert to their derived name on "").
 * Escape leaves edit mode without committing anything.
 */
export function useInlineRename(
  commit: (key: string, name: string) => void,
): InlineRename {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    if (editing === null) return;
    commit(editing, draft.trim());
    setEditing(null);
  };

  return {
    editing,
    start(key, current) {
      setDraft(current);
      setEditing(key);
    },
    inputProps: {
      value: draft,
      onChange: (event) => setDraft(event.target.value),
      onBlur: commitDraft,
      onKeyDown: (event) => {
        if (event.key === "Enter") commitDraft();
        else if (event.key === "Escape") setEditing(null);
      },
    },
  };
}
