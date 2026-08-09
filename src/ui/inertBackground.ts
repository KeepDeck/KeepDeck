/**
 * While a modal layer is up, everything behind it is `inert`.
 *
 * This is the one home of that rule. The app already HAS a notion of who owns
 * keyboard interaction — `keyboardFocusEnabled`, threaded down to every
 * terminal pane — but it only ever decided whether to TAKE focus, never to
 * give it up, and a backdrop that eats clicks does nothing about the
 * keyboard. So a pane that held focus when a dialog opened kept holding it,
 * and every key the user pressed over the dialog still reached the agent.
 *
 * `inert` is the platform's own way to say it, which is why nothing here
 * mirrors focus in app state: the engine makes the subtree unfocusable and
 * untabbable, drops its hit-testing, and BLURS whatever inside it was
 * focused. The pane cannot hold the keyboard while a dialog is open, rather
 * than being asked not to.
 *
 * The background is defined by position, not by name: a modal layer is
 * portaled to `<body>`, so the background is its siblings there. Two rules
 * keep that honest —
 *
 * - a sibling that was ALREADY inert is left alone and never restored; we
 *   undo exactly what we did;
 * - layers nest (a confirm paints over a dialog), so this is refcounted, and
 *   only the last one out lifts it. A count rather than a re-scan on every
 *   acquire: by then the outer layer's own node is a body sibling too, and a
 *   re-scan would make the dialog underneath inert.
 *
 * KNOWN LIMIT: a node appended to `<body>` while a layer is already up does
 * not become inert. Nothing does that today — the surfaces that portal to
 * `<body>` (popovers, the minimized tray) are opened by a click the backdrop
 * eats — and watching for it would cost a MutationObserver for a case that
 * cannot currently happen.
 */

/** Marks a modal layer in the DOM. Lives here because this rule is the thing
 * that has to tell a layer from the background it stands on. */
export const MODAL_OVERLAY_CLASS = "modal-overlay";

/** How many layers are up. */
let held = 0;
/** Exactly the nodes this module made inert, to restore exactly those. */
let inerted: Element[] = [];

/**
 * Make the background behind `layer` inert until the returned release is
 * called. The release is idempotent, so a double-invoked effect teardown
 * cannot unbalance the count.
 */
export function inertBackground(layer: Element): () => void {
  if (held === 0) {
    for (const node of Array.from(document.body.children)) {
      // `layer` is already mounted when this runs; so is any sibling layer
      // that appeared in the same commit.
      if (node === layer || node.classList.contains(MODAL_OVERLAY_CLASS)) {
        continue;
      }
      if (node.hasAttribute("inert")) continue;
      node.setAttribute("inert", "");
      inerted.push(node);
    }
  }
  held += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
    if (held > 0) return;
    for (const node of inerted) node.removeAttribute("inert");
    inerted = [];
  };
}
