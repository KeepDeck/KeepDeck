import { useEffect, useState } from "react";
import { isBehindModalLayer } from "./inertBackground";

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
   * Escape cancels without committing. Blur needs the node so it can tell a
   * user leaving the field from a modal layer taking the keyboard. */
  inputProps: {
    value: string;
    onChange(event: { target: { value: string } }): void;
    onBlur(event: { currentTarget: Node }): void;
    onKeyDown(event: RenameKey): void;
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
 *
 * One blur does NOT commit: the one a modal layer causes. Opening a dialog
 * makes the app root inert and the engine takes the keyboard away, which used
 * to read as "the user finished typing" and wrote the half-entered name.
 * Losing an unfinished draft is recoverable; silently renaming an agent the
 * user was still naming is not. Only reachable since dialogs began claiming
 * the keyboard — before that a rename could only be blurred by a click, which
 * IS the user leaving the field.
 */
/** A key press in the field, as much of it as the rename reads. */
export interface RenameKey {
  key: string;
  /** Mid-composition (IME): Enter picks the candidate, it does not commit. */
  nativeEvent?: { isComposing?: boolean };
  stopPropagation?(): void;
}

export function useInlineRename(
  /** `from` is the name the edit began with — what "unchanged" means, even
   * when the subject was renamed elsewhere while the field stood open. */
  commit: (key: string, name: string, from: string) => void,
  allowed = true,
): InlineRename {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [from, setFrom] = useState("");

  // A surface that may no longer hold the keyboard must not be left with an
  // edit in flight. A modal layer blurs the field itself, but a covering dock
  // does not — it paints over the pane header with no layer and no `inert`,
  // so the field stayed focused underneath and typing renamed the agent out
  // of sight. Same reading as the blur: drop the draft, do not write it.
  useEffect(() => {
    if (!allowed) setEditing(null);
  }, [allowed]);

  const commitDraft = () => {
    if (editing === null) return;
    commit(editing, draft.trim(), from);
    setEditing(null);
  };

  return {
    editing,
    start(key, current) {
      setDraft(current);
      setFrom(current);
      setEditing(key);
    },
    inputProps: {
      value: draft,
      onChange: (event) => setDraft(event.target.value),
      onBlur: (event) => {
        if (isBehindModalLayer(event.currentTarget)) {
          setEditing(null);
          return;
        }
        commitDraft();
      },
      onKeyDown: (event) => {
        if (event.key === "Enter") {
          // A composing IME's Enter picks its candidate: the name is not done.
          if (!event.nativeEvent?.isComposing) commitDraft();
        } else if (event.key === "Escape") {
          // The field's own Escape — it ends the edit, and goes no further:
          // the dialog around it keeps its own (its layer is not the field's).
          event.stopPropagation?.();
          setEditing(null);
        }
      },
    },
  };
}
