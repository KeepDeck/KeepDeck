import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fuzzyFilterBy } from "@keepdeck/ui-kit/Combobox";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import { noAutoCorrect } from "./inputProps";
import { ModalOverlay } from "./ModalOverlay";
import { useEscape } from "./useEscape";

/** One row a palette offers: what a pick hands back, what it reads, the
 * quiet word at its end, and what stands before it (a status ring). */
export interface PaletteItem {
  value: string;
  label: string;
  hint?: string;
  leading?: ReactNode;
}

export interface PaletteSection {
  title: string;
  items: readonly PaletteItem[];
}

/** A line of the windowed list: a section's heading, or a row with its
 * place among the rows (what the arrows count). */
type PaletteRow =
  | { kind: "section"; key: string; title: string }
  | { kind: "item"; key: string; item: PaletteItem; at: number };

const rowKey = (row: PaletteRow) => row.key;
/** A heading's and a row's first-paint height; measured after. */
const rowHeight = (row: PaletteRow) => (row.kind === "section" ? 28 : 34);

interface CommandPaletteProps {
  /** What it is for — its name to a screen reader. */
  label: string;
  /** The search field's prompt, which says what is being picked
   * ("Find a task task-5 waits on…"). */
  placeholder: string;
  sections: readonly PaletteSection[];
  /** What it says when nothing matches — or there is nothing to offer. */
  empty: string;
  onPick(value: string): void;
  onClose(): void;
}

/**
 * Pick one thing out of many, the way Linear's palette does: a panel at
 * the top of the screen, a search field first, the matches under it in
 * their sections, filtering as the person types (fuzzy, by each row's
 * words). The arrows walk every section as one list, Enter or a click
 * picks and the palette is done; Escape or a press outside closes it
 * with nothing picked. One for every kind of pick — what is offered, in
 * which sections, is the caller's.
 */
export function CommandPalette({ label, placeholder, sections, empty, onPick, onClose }: CommandPaletteProps) {
  const surface = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  useEscape(onClose, true, surface);
  useLayoutEffect(() => field.current?.focus(), []);

  const shown = sections
    .map((section) => ({ ...section, items: fuzzyFilterBy(section.items, query, (item) => `${item.label} ${item.hint ?? ""}`) }))
    .filter((section) => section.items.length > 0);
  const flat = shown.flatMap((section) => section.items);
  const cursor = Math.min(highlight, Math.max(flat.length - 1, 0));
  const optionId = (index: number) => `${listId}-option-${index}`;
  // One windowed list of headings and rows — a board's worth of tasks
  // mounts only what is in view.
  const rows: PaletteRow[] = [];
  let at = 0;
  for (const section of shown) {
    rows.push({ kind: "section", key: `section:${section.title}`, title: section.title });
    for (const item of section.items) rows.push({ kind: "item", key: `item:${item.value}`, item, at: at++ });
  }

  const pick = (item: PaletteItem) => {
    onPick(item.value);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length) setHighlight((cursor + (event.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (flat.length) pick(flat[cursor]);
    }
  };

  return (
    <ModalOverlay>
      <div
        className="palette__backdrop"
        onMouseDown={(event) => {
          // A press on the backdrop, not inside the panel, closes it.
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div ref={surface} className="palette" role="dialog" aria-modal="true" aria-label={label}>
          <input
            {...noAutoCorrect}
            ref={field}
            className="palette__field"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optionId(cursor) : undefined}
            aria-label={label}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
          {flat.length === 0 ? (
            <p className="palette__empty">{empty}</p>
          ) : (
            <VirtualList
              items={rows}
              itemKey={rowKey}
              estimate={rowHeight}
              className="palette__list"
              id={listId}
              role="listbox"
              ariaLabel={label}
              // The highlighted row is kept in view as the arrows move it.
              revealKey={rows.find((row) => row.kind === "item" && row.at === cursor)?.key ?? null}
              render={(row) =>
                row.kind === "section" ? (
                  <p className="palette__section">{row.title}</p>
                ) : (
                  <button
                    type="button"
                    role="option"
                    id={optionId(row.at)}
                    aria-selected={row.at === cursor}
                    className={`palette__item${row.at === cursor ? " palette__item--active" : ""}`}
                    // Keep the field focused: a click is a pick, not a blur.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setHighlight(row.at)}
                    onClick={() => pick(row.item)}
                  >
                    {row.item.leading}
                    <span className="palette__label">{row.item.label}</span>
                    {row.item.hint && <span className="palette__hint">{row.item.hint}</span>}
                  </button>
                )
              }
            />
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
