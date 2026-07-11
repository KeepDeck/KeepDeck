/**
 * @keepdeck/ui-kit — the in-app UI primitives shared verbatim by the host and
 * by built-in plugins. Bundled into each consumer (not shared at runtime like
 * react), so a built-in plugin gets the same Dropdown/icons/input props the
 * host renders without vendoring its own copy. The classNames these render
 * into come from the host stylesheet — the builtin-tier rule (a built-in
 * plugin's UI is styled by the app it ships with).
 */
export { Dropdown, type DropdownOption } from "./Dropdown.tsx";
export { Combobox, fuzzyFilter } from "./Combobox.tsx";
export { Peek, type PeekProps } from "./Peek.tsx";
export { noAutoCorrect } from "./inputProps.ts";
export * from "./icons.tsx";
