import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./icons";

/**
 * An in-app replacement for `<select>`: the app renders its own UI for every
 * interaction (no system dialogs, no WebView context menus), and a native
 * select popup is the same kind of foreign chrome. The closed control is a form
 * field; the open menu is our DOM — closes on pick, click-outside and Escape.
 *
 * Vendored from the host's src/ui/Dropdown because a built-in plugin bundles
 * standalone (it can't import host src/), and this stage adds no new npm deps.
 * Its `dropdown*` classNames come from the host stylesheet — the builtin-tier
 * rule.
 */
export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange(value: string): void;
  ariaLabel: string;
  /** Extra class on the wrapper (layout belongs to the call site). */
  className?: string;
}

export function Dropdown({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click-outside closes without picking. Pointerdown (not click) so a drag
  // that starts outside also dismisses.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      ref={rootRef}
      className={`dropdown${className ? ` ${className}` : ""}`}
      onKeyDown={(e) => {
        // Local, not a window listener: the dropdown owns Escape only while
        // focus is inside it, so modal layers keep their own Esc semantics.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="form__input dropdown__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dropdown__label">{current?.label ?? value}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <ul className="dropdown__menu" role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`dropdown__option${o.value === value ? " dropdown__option--active" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
