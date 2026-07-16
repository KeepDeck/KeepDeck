import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FloatingListbox } from "./FloatingListbox";
import { ChevronDownIcon } from "./icons";

export interface DropdownOption {
  value: string;
  /** What the option (and the closed control, when picked) renders — plain
   * text for most call sites, or a small composition (a name plus a status
   * icon) when text alone can't carry it. */
  label: ReactNode;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange(value: string): void;
  ariaLabel: string;
  /** Extra class on the wrapper (layout belongs to the call site). */
  className?: string;
}

/**
 * An in-app replacement for `<select>`: the app renders its own UI for every
 * interaction (no system dialogs, no WebView context menus), and a native
 * select popup is the same kind of foreign chrome. The closed control is a
 * form field; the open menu is our DOM portaled into a viewport-level floating
 * layer, so panel overflow cannot clip it. It closes on pick, click-outside and
 * Escape. Keyboard cursor navigation can come when a consumer needs it.
 */
export function Dropdown({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  // An empty option set has no menu to show: a `role="listbox"` with no
  // options is a dead layer to a pointer and a lie to a screen reader. This
  // is also what the aria pair below reports, so `aria-expanded` never claims
  // a listbox that isn't rendered and `aria-controls` never dangles.
  const menuOpen = open && options.length > 0;

  // Pointer-away closes before the outside control acts; focus-away covers
  // keyboard Tab now that the list is portaled out of the local DOM order.
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("focusin", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("focusin", away, true);
    };
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
        ref={buttonRef}
        type="button"
        className="form__input dropdown__button"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dropdown__label">{current?.label ?? value}</span>
        <ChevronDownIcon />
      </button>
      {menuOpen && (
        <FloatingListbox
          anchorRef={rootRef}
          listRef={menuRef}
          id={listId}
          aria-label={ariaLabel}
        >
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
                  // The picked option is being unmounted with the menu; without
                  // this, focus falls to <body> and the keyboard user loses
                  // their place in the form.
                  buttonRef.current?.focus();
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </FloatingListbox>
      )}
    </div>
  );
}
