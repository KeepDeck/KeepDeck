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
 * Positioning, portalling and clipping are `FloatingListbox`'s, and the
 * open/close discipline is deliberately the same as `Dropdown`'s — pointer
 * and focus away close it, Escape closes it only while focus is inside so
 * modal layers keep their own Escape.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { FloatingListbox } from "./FloatingListbox";

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
  const menuId = useId();

  // An empty action set has no menu to show, and saying otherwise would leave
  // `aria-expanded` claiming a layer that is not rendered.
  const menuOpen = open && actions.length > 0;

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

  return (
    <div
      ref={rootRef}
      className={`kd-menu${className ? ` ${className}` : ""}`}
      onKeyDown={(event) => {
        // Local, not a window listener: the menu owns Escape only while focus
        // is inside it, so modal layers keep their own Esc semantics.
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Button
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
                  setOpen(false);
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
