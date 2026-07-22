/**
 * @keepdeck/ui-kit — the in-app UI primitives shared verbatim by the host and
 * by built-in plugins. Bundled into each consumer (not shared at runtime like
 * react), so a built-in plugin gets the same Dropdown/icons/input props the
 * host renders without vendoring its own copy. The classNames these render
 * into come from the host stylesheet — ui-kit is shared chrome, styled once
 * by the app for every consumer. A plugin's own feature styles are the
 * plugin's: it ships them in its bundle (imported from its entry, emitted as
 * the bundle's index.css — see scripts/build-plugins.mjs), styling only class
 * families rooted in its own namespace and never redefining the shared
 * vocabulary.
 */
export { AgentGlyph, type AgentGlyphIcon } from "./AgentGlyph.tsx";
export { Chip, type ChipProps } from "./Chip.tsx";
export { Dropdown, type DropdownOption } from "./Dropdown.tsx";
export { Combobox, fuzzyFilter } from "./Combobox.tsx";
export { Peek, type PeekProps } from "./Peek.tsx";
export { noAutoCorrect } from "./inputProps.ts";
export { shortPath } from "./paths.ts";
export * from "./icons.tsx";
