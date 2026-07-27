/**
 * The marker a surface carries to say "a file released on me is mine, not the
 * deck's". Read by the host's drop router (`src/app/dragDrop.ts`), which
 * hit-tests the pane under the drop point and must not deliver through
 * anything covering it.
 *
 * It lives in ui-kit because the surfaces that need it do: the host's own
 * chrome, this package's `Peek`, and any built-in plugin's overlay. Left in
 * the drop router, the one place that reads it, it was unreachable from most
 * of them — and the precedent for what follows is already in the tree, where
 * a plugin hardcodes `data-kd-drag-path` because its constant is private to
 * a host hook.
 *
 * An ATTRIBUTE rather than a class: blocking is behaviour, and a class is free
 * to be renamed for how a surface looks.
 *
 * Carry it on anything opaque that covers the deck while it is on screen —
 * INCLUDING modal surfaces. A backdrop that eats pointer events does NOT stop
 * an OS file drop: those arrive from the window as raw viewport coordinates
 * and never consult the DOM, so a Finder drop on an open dialog would deliver
 * into a pane the user cannot see.
 *
 * A surface that is present but not laid out reports a zero rect, which
 * contains no point — so a hidden one needs no special case, and the marker
 * can be unconditional wherever hiding is done by `hidden` or `display: none`.
 */
export const DROP_BLOCKER_ATTR = "data-kd-drop-blocker";

/** Spreadable form: `<div {...dropBlocker()} />`. Keeps consumers from
 * re-spelling the attribute name in a computed key. */
export function dropBlocker(): Record<string, string> {
  return { [DROP_BLOCKER_ATTR]: "" };
}
