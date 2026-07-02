import { useState } from "react";
import { noAutoCorrect } from "./inputProps";

interface SuggestedInputProps {
  value: string;
  /** The prefilled default. While the value still equals it and the field is
   * unfocused, the text renders hint-styled (muted, placeholder-like) — the
   * suggestion IS the value, it just reads as "this is what you'll get". */
  suggestion: string;
  onChange(value: string): void;
  ariaLabel: string;
  placeholder?: string;
  /** Extra wrapper class for layout (flex sizing, spacing). */
  className?: string;
  /** When set, a non-empty value shows a ✕ clear button with this tooltip —
   * for fields where empty is a meaningful state, not just erased text. */
  clearTitle?: string;
  /** Tooltip for the ↺ reset-to-suggestion button. */
  resetTitle?: string;
}

/**
 * Text input prefilled with a suggestion that reads as a hint: muted while the
 * value is untouched, ordinary text once focused or edited, and back to a hint
 * when the user restores the original (equality is the whole state machine —
 * nothing else is tracked).
 *
 * One inline button slot, contextual, never two at once: ✕ clears when there
 * is text (only for `clearTitle` fields), otherwise ↺ restores the suggestion
 * when the value drifted from it. So clearing turns the slot into its own
 * undo, and a reset from an edited value is ✕ then ↺.
 */
export function SuggestedInput({
  value,
  suggestion,
  onChange,
  ariaLabel,
  placeholder,
  className,
  clearTitle,
  resetTitle = "Reset to suggested",
}: SuggestedInputProps) {
  const [focused, setFocused] = useState(false);
  const hint = !focused && suggestion !== "" && value === suggestion;
  const showClear = clearTitle !== undefined && value !== "";
  const showReset = !showClear && suggestion !== "" && value !== suggestion;

  return (
    <div className={`form__field${className ? ` ${className}` : ""}`}>
      <input
        {...noAutoCorrect}
        className={`form__input form__field-input${hint ? " form__input--hint" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          // WebKit parks the caret at the text START when focus arrives
          // without a click (Tab, programmatic) — an untouched input's
          // default selection is (0,0). A prefilled value is edited at its
          // end, so move the caret there. Synchronous on purpose: a real
          // click places its own caret right after focus and still wins.
          const el = e.currentTarget;
          if (el.selectionStart === 0 && el.selectionEnd === 0 && el.value)
            el.setSelectionRange(el.value.length, el.value.length);
        }}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {showClear && (
        <button
          type="button"
          className="form__field-btn"
          onClick={() => onChange("")}
          title={clearTitle}
          aria-label={clearTitle}
        >
          ×
        </button>
      )}
      {showReset && (
        <button
          type="button"
          className="form__field-btn form__field-btn--reset"
          onClick={() => onChange(suggestion)}
          title={resetTitle}
          aria-label={resetTitle}
        >
          ↺
        </button>
      )}
    </div>
  );
}
