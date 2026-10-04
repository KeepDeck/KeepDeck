import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { fuzzyFilterBy } from "./Combobox";
import { FloatingListbox } from "./FloatingListbox";
import { PlusIcon } from "./icons";
import { noAutoCorrect } from "./inputProps";

/** One thing a picker offers: what a pick hands back, and what it reads. */
export interface SearchPickerOption {
  value: string;
  label: string;
}

interface SearchPickerProps {
  /** What the picker does — the button's name and tip ("Add a blocker"). */
  label: string;
  /** The search field's prompt, once it is open. */
  placeholder: string;
  options: readonly SearchPickerOption[];
  onPick(value: string): void;
  /** What the open list says when nothing matches what was typed — or
   * there is nothing to offer at all. */
  empty: string;
  className?: string;
}

/**
 * Add one thing out of many, the way Linear does: a small `+` that opens a
 * search field over the list, filtering as the person types (fuzzy, as
 * `Combobox` filters). Arrows walk the list, Enter or a click picks, and
 * the picker closes back to its `+` — Escape or a click away closes it
 * with nothing picked. Escape stays local, so a dialog's own Escape is
 * not spent on it.
 *
 * For lists too long to scan in a plain menu: a task's blockers out of a
 * team's tasks, an artifact out of a workspace's.
 */
export function SearchPicker({ label, placeholder, options, onPick, empty, className }: SearchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  /** Whether the `+` takes the keyboard back once it is drawn again. */
  const refocus = useRef(false);

  useEffect(() => {
    if (!open) {
      // Back to the `+`, so the keyboard goes on from where it was.
      if (refocus.current) buttonRef.current?.focus();
      refocus.current = false;
      return;
    }
    fieldRef.current?.focus();
    const away = (event: Event) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("focusin", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("focusin", away, true);
    };
  }, [open]);

  const shown = fuzzyFilterBy(options, query, (option) => option.label);
  const cursor = Math.min(highlight, Math.max(shown.length - 1, 0));
  const optionId = (index: number) => `${listId}-option-${index}`;

  const close = () => {
    refocus.current = true;
    setOpen(false);
  };
  const pick = (option: SearchPickerOption) => {
    onPick(option.value);
    close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = shown.length;
      if (count) setHighlight((cursor + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      return;
    }
    if (event.key === "Enter") {
      // Never the form's: Enter here only ever picks.
      event.preventDefault();
      if (shown.length) pick(shown[cursor]);
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  return (
    <div ref={rootRef} className={`search-picker${className ? ` ${className}` : ""}`}>
      {open ? (
        <input
          {...noAutoCorrect}
          ref={fieldRef}
          className="form__input search-picker__field"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown.length ? optionId(cursor) : undefined}
          aria-label={label}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className="search-picker__open"
          aria-label={label}
          title={label}
          onClick={() => {
            setQuery("");
            setHighlight(0);
            setOpen(true);
          }}
        >
          <PlusIcon />
        </button>
      )}
      {open && (
        <FloatingListbox anchorRef={fieldRef} listRef={menuRef} id={listId} aria-label={label} widthFrom="content">
          {shown.length === 0 ? (
            <li className="search-picker__empty" role="presentation">
              {empty}
            </li>
          ) : (
            shown.map((option, index) => (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  id={optionId(index)}
                  aria-selected={index === cursor}
                  className={`dropdown__option${index === cursor ? " dropdown__option--active" : ""}`}
                  // Keep the field focused, so a click is a pick, not a blur.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                >
                  {option.label}
                </button>
              </li>
            ))
          )}
        </FloatingListbox>
      )}
    </div>
  );
}
