/**
 * The register of surfaces that cover the whole window.
 *
 * A full-window overlay is invisible to the app's own "is anything in front
 * of the deck?" rules unless it says so. The dock announces its geometry and
 * dialogs are host state, but a `Peek` is opened by a plugin, inside a
 * resident overlay the host neither owns nor inspects — so the app went on
 * believing a pane completely hidden behind one was on screen, and dropped
 * the crash banner it would otherwise have shown.
 *
 * A counter, not a flag: peeks can stack (a file preview opened from a diff),
 * and the window stays covered until the last one leaves.
 */

let covers = 0;
const listeners = new Set<() => void>();

/** Declare the window covered until the returned release is called. */
export function coverWindow(): () => void {
  covers += 1;
  notify();
  let released = false;
  return () => {
    // Idempotent: React may run a cleanup more than once, and a double
    // release would uncover a window still under another surface.
    if (released) return;
    released = true;
    covers -= 1;
    notify();
  };
}

/** Whether anything currently covers the window. */
export function windowCovered(): boolean {
  return covers > 0;
}

/** Subscribe to changes; returns the unsubscribe. Pairs with
 * `windowCovered` as a `useSyncExternalStore` source. */
export function subscribeWindowCovers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}
