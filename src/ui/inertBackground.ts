/**
 * While modal layers are up, everything behind the TOP one is `inert`.
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
 * untabbable, drops its hit-testing, and blurs whatever inside it was
 * focused. The pane cannot hold the keyboard while a dialog is open, rather
 * than being asked not to.
 *
 * A STACK, not a count. Layers nest — a confirm paints over a dialog — and
 * the dialog underneath is background too: with only a refcount it stayed
 * interactive, so Tab past the confirm's last control wrapped around, skipped
 * the inert app root, and landed in the form the confirm was covering, where
 * typing edited it and Enter could fire its Save. Every push and pop
 * therefore re-derives from scratch: undo exactly what we set, then make
 * everything but the current top inert. That also makes the order of pops
 * irrelevant, which a count could not survive.
 *
 * The background is defined by position: a layer is portaled to `<body>`, so
 * the background is its siblings. No marker class is needed — the stack knows
 * which nodes are layers, including two that mount in the same commit.
 *
 * KNOWN LIMIT, and it cuts both ways: nodes appended to `<body>` while a layer
 * is already up are NOT inert. Today that is what we want — a tooltip opened
 * from inside a dialog portals to `<body>` too (`Tooltip`, `WindowBurn`), and
 * it belongs to the layer, not to the background. The cost is the other
 * direction: if a further layer pushes while such a tooltip is open, the
 * re-derive treats it as background and freezes it. Rare enough to name rather
 * than to chase with a MutationObserver.
 *
 * PLATFORM FLOOR: `inert` needs WebKit 15.5+, and the app's
 * `minimumSystemVersion` is lower. Where the attribute is not implemented
 * setting it is silently inert itself; the keyboard hand-over then rests on
 * `useEscape` cancelling the press and on the pane's own release, which is
 * weaker but not nothing. No feature test, because there is no third
 * behaviour to branch to.
 */

/** Live layers, oldest first. The last one is the only interactive surface. */
const layers: Element[] = [];
/** Exactly the nodes this module made inert, so it restores exactly those. */
let inerted: Element[] = [];

/** Re-derive the whole background from the current stack. */
function apply(): void {
  for (const node of inerted) node.removeAttribute("inert");
  inerted = [];
  const top = layers[layers.length - 1];
  if (!top) return;
  for (const node of Array.from(document.body.children)) {
    if (node === top) continue;
    node.setAttribute("inert", "");
    inerted.push(node);
  }
}

/**
 * Push `layer` as the interactive surface; everything else in `<body>` becomes
 * inert until the returned release is called. Releasing a layer that is no
 * longer on the stack does nothing, so a double teardown is harmless.
 */
export function inertBackground(layer: Element): () => void {
  layers.push(layer);
  apply();
  return () => {
    const at = layers.indexOf(layer);
    if (at === -1) return;
    layers.splice(at, 1);
    apply();
  };
}
