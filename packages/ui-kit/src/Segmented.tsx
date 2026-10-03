import { useRef, type KeyboardEvent, type ReactNode } from "react";

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

/** An option's classes. md: the form's choice row (form.css .form__type).
 * sm: the small secondary button itself (button.css), so a toolbar's
 * choice is the very box of the toggle beside it — and its checked state
 * the button's pressed plate. */
function optionClass(size: "md" | "sm", checked: boolean): string {
  if (size === "sm") return "kd-btn kd-btn--secondary kd-btn--sm";
  return checked ? "form__type form__type--active" : "form__type";
}

/** The option an arrow key moves to from `from`: the next (or previous)
 * one that is not disabled, wrapping; Home and End go to the ends. Null for
 * any other key, or when nothing else may be chosen. */
export function segmentStep(
  key: string,
  from: number,
  disabled: readonly boolean[],
): number | null {
  const count = disabled.length;
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  const start = key === "Home" ? -1 : key === "End" ? count : step === 0 ? null : from;
  if (start === null) return null;
  const direction = key === "End" ? -1 : key === "Home" ? 1 : step;
  for (let i = 1; i <= count; i++) {
    const at = (((start + direction * i) % count) + count) % count;
    if (!disabled[at]) return at === from ? null : at;
  }
  return null;
}

/**
 * One of a few, side by side — the deck's choice row: a row of buttons,
 * the chosen one a light plate with dark text (form.css .form__type). A
 * radiogroup by the house's radio manners: ONE Tab stop (the checked
 * option, or the first that may be chosen), arrows move the choice along
 * it, and pressing the option already chosen changes nothing.
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const off = options.map((option) => disabled || Boolean(option.disabled));
  const checkedAt = options.findIndex((option) => option.value === value);
  const tabStop = checkedAt >= 0 && !off[checkedAt] ? checkedAt : off.indexOf(false);
  const choose = (index: number) => {
    if (index !== checkedAt) onChange(options[index].value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const to = segmentStep(event.key, from, off);
    if (to === null) return;
    event.preventDefault();
    refs.current[to]?.focus();
    choose(to);
  };
  return (
    <div
      className={["form__types", size === "sm" && "form__types--sm", className].filter(Boolean).join(" ")}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option, index) => {
        const checked = index === checkedAt;
        return (
          <button
            key={String(option.value)}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            title={option.title}
            className={optionClass(size, checked)}
            disabled={off[index]}
            tabIndex={index === tabStop ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => choose(index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
