import { useId, useRef, useState, type ReactNode } from "react";
import { FloatingListbox } from "./FloatingListbox";
import { ChevronDownIcon } from "./icons";
import { useAwayClose } from "./useAwayClose";
import { closesMenu, dropdownView, type DropdownOption } from "./dropdownView";

export type { DropdownOption } from "./dropdownView";

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange(value: string): void;
  ariaLabel: string;
  /** Extra class on the wrapper (layout belongs to the call site). */
  className?: string;
  /** `field` (default): a form field the width of its column. `inline`: a
   *  value in a line of text — a property list's "To do ▾" — as wide as
   *  its words, its menu as wide as its options rather than as the narrow
   *  value that opened it. */
  variant?: "field" | "inline";
  /** `md` (default): a dialog's field. `sm`: a toolbar's or a compact
   *  form's — a button's height, as wide as its value, its menu as wide as
   *  its options (never narrower than the field). */
  size?: "md" | "sm";
  /** An offer rather than a value ("Attach an artifact…"): quieter ink,
   *  small type — it says what can be done, not what is. */
  quiet?: boolean;
  /** Words under the options, inside the menu — why an option is
   *  disabled, said where the person meets it. */
  note?: ReactNode;
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
  variant = "field",
  size = "md",
  quiet = false,
  note,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  useAwayClose(open, () => setOpen(false), rootRef, menuRef);
  const view = dropdownView({ options, value, open, variant, size, quiet, className });
  const { menuOpen } = view;

  return (
    <div
      ref={rootRef}
      className={view.className}
      onKeyDown={(e) => {
        // Local, not a window listener: the dropdown owns Escape only while
        // focus is inside it, so modal layers keep their own Esc semantics.
        if (closesMenu(e.key, open)) {
          e.stopPropagation();
          // Same reason as after a pick, and it was missing here: the option
          // holding focus is unmounted with the list, and focus falls to
          // <body> unless it is put back first.
          buttonRef.current?.focus();
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
        <span className="dropdown__label">{view.current}</span>
        <ChevronDownIcon />
      </button>
      {menuOpen && (
        <FloatingListbox
          anchorRef={rootRef}
          listRef={menuRef}
          id={listId}
          aria-label={ariaLabel}
          widthFrom={view.widthFrom}
          onAnchorHidden={() => setOpen(false)}
        >
          {view.items.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.selected}
                // Refused, yet reachable: a keyboard or a reader still meets
                // it, and hears why (the note) — `disabled` would drop it from
                // both. A press picks nothing.
                aria-disabled={o.disabled || undefined}
                aria-describedby={o.disabled && note ? `${listId}-note` : undefined}
                className={o.className}
                onClick={() => {
                  if (o.disabled) return;
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
          {note && (
            <li role="none" id={`${listId}-note`} className="dropdown__note">
              {note}
            </li>
          )}
        </FloatingListbox>
      )}
    </div>
  );
}
