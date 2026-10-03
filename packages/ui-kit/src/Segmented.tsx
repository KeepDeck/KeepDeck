import type { ReactNode } from "react";

export interface SegmentedOption<V> {
  value: V;
  label: ReactNode;
  /** The option's accessible name, when its label alone does not say it
   *  (a bare "On" under a section heading). */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<V> {
  options: readonly SegmentedOption<V>[];
  /** The option chosen now — compared by identity, so a boolean, a string
   *  or null is fine. */
  value: V;
  onChange(value: V): void;
  /** Names the group — what is being chosen. */
  ariaLabel?: string;
  /** Every option off at once (the setting does not apply right now). */
  disabled?: boolean;
  /** `md` (default): a form's choice row. `sm`: a toolbar's. */
  size?: "md" | "sm";
  /** Layout hook for the call site. */
  className?: string;
}

/**
 * One of a few, side by side — the deck's choice row: a row of buttons,
 * the chosen one a light plate with dark text (form.css .form__type). A
 * radiogroup: one is checked, a press checks another.
 */
export function Segmented<V>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  size = "md",
  className,
}: SegmentedProps<V>) {
  return (
    <div
      className={["form__types", size === "sm" && "form__types--sm", className].filter(Boolean).join(" ")}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            title={option.title}
            className={checked ? "form__type form__type--active" : "form__type"}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
