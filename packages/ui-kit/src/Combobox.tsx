import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { FloatingListbox } from "./FloatingListbox";
import { ChevronDownIcon } from "./icons";
import { noAutoCorrect } from "./inputProps";

/** How well `query` matches `candidate`: prefix beats substring beats sparse
 * subsequence (characters in order, gaps allowed — "fuzzy"). Null = no match.
 * Case-insensitive; an empty query matches everything as a prefix. */
function fuzzyRank(candidate: string, query: string): number | null {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  if (c.startsWith(q)) return 0;
  if (c.includes(q)) return 1;
  let matched = 0;
  for (const ch of c) {
    if (ch === q[matched]) matched += 1;
    if (matched === q.length) return 2;
  }
  return null;
}

/**
 * The options fuzzy-matching `query`, best tier first: prefix matches, then
 * substring, then sparse subsequence. Within a tier the input order is kept
 * (sort is stable), so an alphabetical list stays alphabetical per tier.
 * Pure — exported for the menu's tests and any non-React consumer.
 */
export function fuzzyFilter(options: string[], query: string): string[] {
  const q = query.trim();
  if (!q) return options;
  return options
    .map((option) => ({ option, rank: fuzzyRank(option, q) }))
    .filter((entry): entry is { option: string; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.option);
}

interface ComboboxProps {
  /** The full option list; what the menu shows is `fuzzyFilter`ed by the
   * text typed since the menu opened. */
  options: string[];
  value: string;
  /** Fires for every edit AND on picking an option — the value is always the
   * plain text; free text (no matching option) is the caller's to judge. */
  onChange(value: string): void;
  ariaLabel: string;
  placeholder?: string;
  /** Extra class on the wrapper (layout belongs to the call site). */
  className?: string;
}

/**
 * An editable sibling of [`Dropdown`]: a text field whose menu filters as the
 * user types (fuzzy — see [`fuzzyFilter`]). Same in-app-UI stance: the open
 * menu is our DOM portaled into a viewport-level floating layer, closed by
 * pick, click-outside and Escape (which stays local so modal layers keep their
 * own Esc), never an OS popup.
 *
 * Opening via focus or the chevron shows ALL options; the filter only kicks
 * in for text typed after that, so a value picked earlier doesn't pin the
 * reopened menu to itself. Enter with the menu open picks the highlighted
 * option and goes no further; with it closed, Enter keeps its form meaning
 * (submit), so the field composes into dialogs.
 */
export function Combobox({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  // Whether the user typed since the menu opened — only then does the menu
  // filter. A fresh open browses the full list.
  const [typed, setTyped] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

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

  const filtered = typed ? fuzzyFilter(options, value) : options;
  // The list can shrink under the cursor (a keystroke narrows the filter);
  // clamping here beats effect-syncing state that render already derives.
  const cursor = Math.min(highlight, Math.max(filtered.length - 1, 0));
  const optionId = (index: number) => `${listId}-option-${index}`;
  // What the user can actually see: an open combobox whose filter matches
  // nothing renders no listbox, so the aria pair below must not announce one.
  const menuOpen = open && filtered.length > 0;

  const openMenu = () => {
    setOpen(true);
    setTyped(false);
    setHighlight(0);
  };

  const pick = (option: string) => {
    onChange(option);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); // the caret must not jump to the text's edges
      if (!open) {
        openMenu();
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      const count = filtered.length;
      if (count) setHighlight((cursor + step + count) % count);
      return;
    }
    if (e.key === "Enter" && open && filtered.length) {
      // Pick, don't submit — Enter only reaches the form once the menu is
      // closed, so "choose from the list" and "confirm the dialog" stay two
      // distinct presses.
      e.preventDefault();
      pick(filtered[cursor]);
    }
  };

  return (
    <div
      ref={rootRef}
      className={`combobox${className ? ` ${className}` : ""}`}
      onKeyDown={(e) => {
        // Local, not a window listener: Escape closes the MENU only while
        // it's open; a closed combobox lets it bubble to the modal's own Esc.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <input
        {...noAutoCorrect}
        className="form__input combobox__input"
        role="combobox"
        aria-expanded={menuOpen}
        aria-autocomplete="list"
        aria-controls={menuOpen ? listId : undefined}
        aria-activedescendant={menuOpen ? optionId(cursor) : undefined}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setTyped(true);
          setHighlight(0);
        }}
        onFocus={openMenu}
        // A pick or Escape closes the menu but keeps the field focused, so a
        // later click gets no focus event — reopen on the click itself.
        onClick={() => {
          if (!open) openMenu();
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="combobox__toggle"
        tabIndex={-1}
        aria-label={`Toggle ${ariaLabel} options`}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <ChevronDownIcon />
      </button>
      {menuOpen && (
        <FloatingListbox
          anchorRef={rootRef}
          listRef={menuRef}
          id={listId}
          aria-label={ariaLabel}
        >
          {filtered.map((option, index) => (
            <li key={option}>
              <button
                type="button"
                role="option"
                id={optionId(index)}
                aria-selected={option === value}
                className={`dropdown__option${index === cursor ? " dropdown__option--active" : ""}`}
                onMouseDown={(e) => e.preventDefault()} // keep the input focused
                onClick={() => pick(option)}
              >
                {option}
              </button>
            </li>
          ))}
        </FloatingListbox>
      )}
    </div>
  );
}
