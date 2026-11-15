/**
 * A button that opens a short list of ACTIONS.
 *
 * Not `Dropdown`, which is this app's replacement for `<select>`: that one
 * carries a value, marks one option selected, and reports itself to a screen
 * reader as a listbox. A menu has no value and nothing is selected in it —
 * every item is a thing that happens when pressed. Reusing the listbox for
 * actions would tell a screen-reader user they are choosing among states.
 *
 * It exists because a bar needs two of these and they are the same control:
 * one create button whose menu holds the ways to create, and one overflow
 * button whose menu holds what did not fit. Writing that twice is how a
 * "temporary" second menu becomes permanent.
 *
 * Positioning, portalling and clipping are `FloatingListbox`'s, and going-away
 * is `useAwayClose`'s — the same one `Dropdown` uses, so a menu and a select
 * cannot drift apart in how they let go. Escape stays local to each of them:
 * it closes this menu only while focus is inside, so a dialog above keeps its
 * own Escape.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { FloatingListbox } from "./FloatingListbox";
import { useAwayClose } from "./useAwayClose";

export interface MenuAction {
  id: string;
  label: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  /** Why it is refused, when it is. A disabled item with no reason leaves the
   *  reader guessing at a rule they cannot see — so this is DRAWN, under the
   *  label, rather than hidden in a `title` this platform never renders.
   *
   *  Only refusals get a second line. An enabled item explaining itself is a
   *  different feature (a menu of descriptions), and the two would be told
   *  apart by nothing the reader can see. */
  refusal?: string;
  /** A rule above this item — where one group of acts ends and the next
   *  begins. Never above the first item. */
  separatorBefore?: boolean;
}

export interface MenuButtonProps {
  actions: readonly MenuAction[];
  /** Names both the button and the menu it opens. */
  ariaLabel: string;
  title?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  /** What the closed button shows. */
  children: ReactNode;
}

export function MenuButton({
  actions,
  ariaLabel,
  title,
  variant,
  size,
  className,
  children,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  // Closing unmounts whatever was focused in the menu, and focus lands on
  // `<body>` — from where the next Tab restarts at the top of the page. So
  // when the menu goes away by the user's own doing (a pick, an Escape),
  // focus goes back where it started.
  //
  // Not on pointer-away: there the browser is already giving focus to whatever
  // was pressed, and taking it back would be the menu having the last word
  // over the thing the user actually reached for.
  const closeAndRestore = () => {
    triggerRef.current?.focus();
    setOpen(false);
  };

  // An empty action set has no menu to show, and saying otherwise would leave
  // `aria-expanded` claiming a layer that is not rendered.
  const menuOpen = open && actions.length > 0;

  useAwayClose(open, () => setOpen(false), rootRef, menuRef);

  return (
    <div
      ref={rootRef}
      className={`kd-menu${className ? ` ${className}` : ""}`}
      onKeyDown={(event) => {
        // Escape on the closed-over trigger. Inside the list the list owns
        // its keys (`MenuList`), and stops the ones it handles.
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          closeAndRestore();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        label={ariaLabel}
        title={title}
        hasPopup="menu"
        expanded={menuOpen}
        controls={menuOpen ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </Button>
      {menuOpen && (
        <MenuList
          anchorRef={rootRef}
          listRef={menuRef}
          id={menuId}
          ariaLabel={ariaLabel}
          actions={actions}
          onClose={closeAndRestore}
          onAnchorHidden={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The list a menu opens — its items, how the keyboard walks them, how a
 * pick lets go — whatever opened it: a button (`MenuButton`) or a pointer
 * (`ContextMenu`). One list, so the two kinds of menu cannot drift apart in
 * how they read or how they are walked.
 */
export function MenuList({
  anchorRef,
  listRef,
  id,
  ariaLabel,
  actions,
  onClose,
  onAnchorHidden,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLUListElement | null>;
  id: string;
  ariaLabel: string;
  actions: readonly MenuAction[];
  /** Let go by the user's own doing — a pick, an Escape: the opener puts
   *  focus back where it started. */
  onClose(): void;
  onAnchorHidden?: () => void;
}) {
  // A menu is walked by the keyboard: opened, focus is on its first item;
  // the arrows (and Home / End) move it along, wrapping — the menu pattern
  // its role announces.
  useEffect(() => {
    itemsOf(listRef.current)[0]?.focus();
  }, [listRef]);

  return (
    <FloatingListbox
      anchorRef={anchorRef}
      listRef={listRef}
      id={id}
      role="menu"
      widthFrom="content"
      aria-label={ariaLabel}
      onAnchorHidden={onAnchorHidden}
      onKeyDown={(event) => {
        // Local, not a window listener: the menu owns its keys only while
        // focus is inside it, so modal layers keep their own Esc semantics.
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        const items = itemsOf(listRef.current);
        const to = menuStep(event.key, document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1, items.length);
        if (to === null) return;
        event.preventDefault();
        event.stopPropagation();
        items[to]?.focus();
      }}
    >
      {actions.map((action, at) => (
        <MenuItem key={action.id} action={action} separated={at > 0 && action.separatorBefore === true} onClose={onClose} />
      ))}
    </FloatingListbox>
  );
}

function MenuItem({ action, separated, onClose }: { action: MenuAction; separated: boolean; onClose(): void }) {
  return (
    <>
      {separated && <li role="separator" className="kd-menu__separator" />}
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="kd-menu__item"
          /* `aria-disabled`, not `disabled`: a refused item has to stay
             reachable, or the reason it carries is unreadable to exactly
             the person it is for. A native disabled button takes no
             pointer, no hover and no focus — it can only be looked at,
             which is why its explanation used to live in a `title` and
             go nowhere. */
          aria-disabled={action.disabled || undefined}
          onClick={() => {
            if (action.disabled) return;
            // Focus first, then act: whatever the action opens is free
            // to take focus for itself, and nothing follows behind it
            // to pull focus back out.
            onClose();
            action.onSelect();
          }}
        >
          <span className="kd-menu__label">{action.label}</span>
          {action.disabled && action.refusal && <span className="kd-menu__refusal">{action.refusal}</span>}
        </button>
      </li>
    </>
  );
}

/** A menu's items, in order. */
function itemsOf(menu: HTMLElement | null): HTMLButtonElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : [];
}

/** Where a key moves the focus in a menu of `count` items from `at` (-1:
 * none yet): Down and Up step, wrapping; Home and End go to the ends. Null
 * for any other key. A refused item is still reached — its reason is read
 * there. */
export function menuStep(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return at < 0 ? 0 : (at + 1) % count;
    case "ArrowUp":
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
