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
import { useId, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { FloatingListbox } from "./FloatingListbox";
import { useAwayClose } from "./useAwayClose";

export interface MenuAction {
  id: string;
  label: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  /** Why it is refused, when it is. A disabled item with no reason leaves the
   *  reader guessing at a rule they cannot see. */
  title?: string;
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
        // Local, not a window listener: the menu owns Escape only while focus
        // is inside it, so modal layers keep their own Esc semantics.
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
        <FloatingListbox
          anchorRef={rootRef}
          listRef={menuRef}
          id={menuId}
          role="menu"
          widthFrom="content"
          aria-label={ariaLabel}
        >
          {actions.map((action) => (
            <li key={action.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="kd-menu__item"
                disabled={action.disabled}
                title={action.title}
                onClick={() => {
                  // Focus first, then act: whatever the action opens is free
                  // to take focus for itself, and nothing follows behind it
                  // to pull focus back out.
                  closeAndRestore();
                  action.onSelect();
                }}
              >
                {action.label}
              </button>
            </li>
          ))}
        </FloatingListbox>
      )}
    </div>
  );
}
