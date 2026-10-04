import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import { noAutoCorrect } from "./inputProps";
import { ModalOverlay } from "./ModalOverlay";
import { clampCursor, paletteRows, stepCursor, type PaletteItem, type PaletteRow, type PaletteSection } from "./paletteRows";
import { useEscape } from "./useEscape";

export type { PaletteItem, PaletteSection } from "./paletteRows";

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
  /** The field names the highlighted row only while the window has it on
   * the page — a row scrolled out by hand is gone, and the field must not
   * name an element that is not there. Written by the row itself as it
   * mounts and leaves: no state, so no render the list's anchoring would
   * answer by scrolling back. */
  const nameActive = (row: HTMLElement | null) => {
    if (row) field.current?.setAttribute("aria-activedescendant", row.id);
    else field.current?.removeAttribute("aria-activedescendant");
  };
  const listId = useId();
  useEscape(onClose, true, surface);
  // The keyboard goes back where it came from once the palette is done —
  // the + that opened it — when that is still on screen. Read as the first
  // render runs: by the effects, the overlay has made it inert and blurred.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    field.current?.focus();
    return () => {
      // After the overlay has let the background go: until then the
      // opener is inert and takes no focus.
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [opener]);

  // What is shown, and where the highlight stands, are paletteRows' and
  // the cursor rules' to say.
  const { rows, count } = paletteRows(sections, query);
  const cursor = clampCursor(highlight, count);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const highlighted = rows.find((row) => row.kind === "item" && row.at === cursor);

  const pick = (item: PaletteItem) => {
    onPick(item.value);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(stepCursor(cursor, count, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      // An IME's Enter confirms what is being composed — it picks nothing.
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (highlighted?.kind === "item") pick(highlighted.item);
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
            // A list to point at only while there is one.
            aria-expanded={count > 0}
            aria-controls={count > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-label={label}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
          {count === 0 ? (
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
              revealKey={highlighted?.key ?? null}
              render={(row) =>
                row.kind === "section" ? (
                  <p className="palette__section">{row.title}</p>
                ) : (
                  <button
                    type="button"
                    role="option"
                    id={optionId(row.at)}
                    ref={row.at === cursor ? nameActive : undefined}
                    aria-selected={row.at === cursor}
                    // Where it stands in the whole list, not just the
                    // window of it on the page.
                    aria-setsize={count}
                    aria-posinset={row.at + 1}
                    // The field holds the keyboard (a combobox): rows are
                    // reached by the arrows, not by Tab.
                    tabIndex={-1}
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
