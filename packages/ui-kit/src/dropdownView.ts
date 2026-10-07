import type { ReactNode } from "react";

/** One option of a Dropdown: the value it sends, what it renders, and
 * whether it is refused now. */
export interface DropdownOption {
  value: string;
  /** What the option (and the closed control, when picked) renders — plain
   * text for most call sites, or a small composition (a name plus a status
   * icon) when text alone can't carry it. */
  label: ReactNode;
  /** Shown but not to be picked — where a choice exists and is refused
   * now; the menu's `note` says why. */
  disabled?: boolean;
}

/** What the Dropdown draws for what it is given — every decision of the
 * control, away from React: the component holds the open state, the refs
 * and the focus, and maps this. */
export interface DropdownView {
  className: string;
  /** Whether the menu is drawn: open, and something to pick — a listbox
   * with no options is a dead layer to a pointer and a lie to a screen
   * reader, and the aria pair reports this same answer. */
  menuOpen: boolean;
  /** The closed control's words: the picked option's, or the raw value. */
  current: ReactNode;
  /** How wide the menu is: the anchor's (a field as wide as its form), or
   * its content's, never narrower than the anchor — wherever the control is
   * only as wide as its picked value (a value inside a line of text, a
   * small field in a toolbar), which a longer option would outgrow. */
  widthFrom: "anchor" | "content";
  items: { value: string; label: ReactNode; disabled: boolean; selected: boolean; className: string }[];
}

export function dropdownView(input: {
  options: readonly DropdownOption[];
  value: string;
  open: boolean;
  variant: "field" | "inline";
  size: "md" | "sm";
  quiet: boolean;
  className?: string;
}): DropdownView {
  const { options, value } = input;
  const items = options.map((option) => {
    const selected = option.value === value;
    return {
      value: option.value,
      label: option.label,
      disabled: option.disabled === true,
      selected,
      className: selected ? "dropdown__option dropdown__option--active" : "dropdown__option",
    };
  });
  return {
    className: [
      "dropdown",
      input.variant === "inline" && "dropdown--inline",
      input.size === "sm" && "dropdown--sm",
      input.quiet && "dropdown--quiet",
      input.className,
    ]
      .filter(Boolean)
      .join(" "),
    menuOpen: input.open && options.length > 0,
    current: items.find((item) => item.selected)?.label ?? value,
    widthFrom: input.variant === "inline" || input.size === "sm" ? "content" : "anchor",
    items,
  };
}

/** Whether a key closes the menu: Escape, while it is open — the
 * dropdown's own, so a modal under it keeps its own Escape. */
export function closesMenu(key: string, open: boolean): boolean {
  return key === "Escape" && open;
}
