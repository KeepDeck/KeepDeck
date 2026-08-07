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
 *
 * TWO shared classes are part of that vocabulary and are the ONLY way a
 * built-in plugin may touch selection, because a plugin stylesheet declaring
 * `user-select` fails src/styles/selection.test.ts:
 *
 *   .kd-selectable — text meant to be read and copied out: a log, a
 *     transcript, peeked file content, an error string a user will paste into
 *     a bug report. The app is desktop chrome, so nothing is selectable by
 *     default and this is how something opts back in.
 *   .kd-inert — chrome sitting INSIDE such a region that must stay out of the
 *     copy: a diff's line-number gutter, a hunk header.
 *
 * Each carries the matching cursor with it, so the pointer never promises a
 * selection the text will not give. Never put .kd-selectable inside a <label>:
 * selecting text there activates the label and operates its control.
 */
export { AgentGlyph, type AgentGlyphIcon } from "./AgentGlyph.tsx";
export {
  BranchBadge,
  StoppedMarker,
  TeamBadge,
  YoloBadge,
  teamBadgeTitle,
  type BranchBadgeProps,
  type StoppedMarkerProps,
  type TeamBadgeProps,
  type YoloBadgeProps,
} from "./badges.tsx";
export { Chip, type ChipProps } from "./Chip.tsx";
export { Dropdown, type DropdownOption } from "./Dropdown.tsx";
export { Combobox, fuzzyFilter } from "./Combobox.tsx";
export { DROP_BLOCKER_ATTR, dropBlocker } from "./dropBlocker.ts";
export { Peek, type PeekProps } from "./Peek.tsx";
export { noAutoCorrect } from "./inputProps.ts";
export { shortPath } from "./paths.ts";
export * from "./icons.tsx";
