/**
 * The topmost modal layer is the interactive surface; everything else is
 * background. This module is the one home of that rule, and it owns BOTH
 * halves of it: the background is `inert`, and the top layer holds the
 * keyboard.
 *
 * The app already HAS a notion of who may own keyboard interaction —
 * `keyboardFocusEnabled`, threaded down to every terminal pane — but it only
 * ever decided whether to TAKE focus, never to give it up, and a backdrop
 * that eats clicks does nothing about the keyboard. So a pane that held focus
 * when a dialog opened kept holding it, and every key the user pressed over
 * the dialog still reached the agent.
 *
 * `inert` is the platform's own way to say it, which is why nothing here
 * mirrors focus in app state: the engine makes the subtree unfocusable and
 * untabbable, drops its hit-testing, and blurs whatever inside it was
 * focused.
 *
 * A STACK, not a count. Layers nest — a confirm paints over a dialog — and
 * the dialog underneath is background too: with only a refcount it stayed
 * interactive, so Tab past the confirm's last control wrapped around, skipped
 * the inert app root, and landed in the form the confirm was covering, where
 * typing edited it and Enter could fire its Save. Every push and pop
 * re-derives from scratch, which also makes the order of pops irrelevant.
 *
 * Re-deriving is why the KEYBOARD belongs here too rather than to the shell
 * that pushes a layer. A pop is the moment the layer underneath becomes the
 * live surface again — and the engine had blurred it when it went inert, so
 * something has to give it the keyboard back. Only the stack knows there IS a
 * layer underneath. An earlier attempt had each shell remember its own
 * invoker and restore it on the way out; it could not work, because by the
 * time a shell's effect runs React has already placed focus inside the dialog
 * (`autoFocus` commits child-first) and the pane behind has already released
 * it, so the "invoker" it captured was null or `<body>` on nearly every path.
 *
 * The background is defined by position: a layer is portaled to `<body>`, so
 * the background is its siblings. `layer` MUST therefore be a direct child of
 * `<body>` — a nested node would get its own ancestor marked and die inside
 * it. No marker class is needed; the stack knows which nodes are layers,
 * including two that mount in the same commit.
 *
 * WHAT IS AND IS NOT COVERED, both directions. Nodes appended to `<body>`
 * while a layer is already up are not inert, and that is deliberate: a
 * tooltip opened from inside a dialog portals to `<body>` too (`Tooltip`,
 * `WindowBurn`) and belongs to the layer, not the background. The cost is
 * that position cannot tell them apart later — the next push or pop
 * re-derives and marks such a tooltip as background, and re-marks it on every
 * subsequent apply, so it stays inert for the rest of its life rather than
 * just while the extra layer is up. Its anchor is inside the live layer, so
 * a mouse-out still unmounts it. Rare enough to name rather than chase with
 * a MutationObserver.
 *
 * PLATFORM FLOOR: `inert` needs WebKit 15.5+, and the app's
 * `minimumSystemVersion` is lower. Where the attribute is unimplemented
 * setting it does nothing and the keyboard hand-over rests on `useEscape`
 * cancelling the press and on the pane's own release — weaker, but not
 * nothing. [`isBehindModalLayer`] is deliberately answered from the STACK
 * rather than from the attribute, so arbitration keeps working down there.
 */

/** Live layers, oldest first. The last one is the interactive surface. */
const layers: HTMLElement[] = [];
/** Exactly the nodes this module made inert, so it restores exactly those. */
let inerted: Element[] = [];

/** Re-derive the background, and the keyboard, from the current stack. */
function apply(): void {
  for (const node of inerted) node.removeAttribute("inert");
  inerted = [];
  const top = layers[layers.length - 1];
  if (!top) return;

  const root = top.ownerDocument;
  for (const node of Array.from(root.body.children)) {
    if (node === top) continue;
    node.setAttribute("inert", "");
    inerted.push(node);
  }
  // The live surface holds the keyboard — unless it already placed it, which
  // a dialog that autofocuses its own control has done by now. Taking it back
  // would undo that choice.
  if (!top.contains(root.activeElement)) top.focus({ preventScroll: true });
}

/**
 * Push `layer` — a direct child of `<body>` — as the interactive surface;
 * everything else becomes inert until the returned release is called.
 * Releasing a layer that is no longer on the stack does nothing, so a double
 * teardown is harmless.
 */
export function inertBackground(layer: HTMLElement): () => void {
  layers.push(layer);
  apply();
  return () => {
    const at = layers.indexOf(layer);
    if (at === -1) return;
    layers.splice(at, 1);
    apply();
  };
}

/**
 * Is `node` behind a modal layer rather than part of the live surface?
 *
 * The question every light-dismiss surface has to ask before acting on a key:
 * a popover left open under a dialog must not answer the Escape that belongs
 * to the dialog. Answered from the stack, not by looking for the `inert`
 * attribute — which is this module's private mechanism, is absent below the
 * platform floor, and would make every caller depend on how the rule happens
 * to be enforced rather than on the rule.
 */
export function isBehindModalLayer(node: Node | null | undefined): boolean {
  const top = layers[layers.length - 1];
  if (!top || !node) return false;
  return !top.contains(node);
}
