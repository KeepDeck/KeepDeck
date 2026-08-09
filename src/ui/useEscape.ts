import { useEffect } from "react";

/**
 * Invoke `handler` whenever Escape is pressed while the component is mounted
 * and `enabled`.
 *
 * `enabled` is not a convenience: cancelling the press is a claim on it, and
 * a surface must not claim a key it will not act on. Several callers guard
 * their handler on their own state — a form with no cancel to run, a dialog
 * with a confirm stacked over it — and with the guard INSIDE the closure the
 * hook swallowed the press window-wide and dismissed nothing. Say it out
 * here, where the hook can decline before touching the event.
 */
export function useEscape(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // A HELD key repeats, and one dismissal must not stand for the next
      // dialog's: notices queue, so a repeat would pop one the user never
      // saw. One press, one dismissal.
      //
      // A repeat is left UNTOUCHED rather than swallowed, and this hook could
      // not swallow it anyway: the first press unmounts the surface, so the
      // repeats that follow arrive with no handler listening. They reach the
      // pane, whose terminal now legitimately holds the keyboard, and the
      // agent reads them as an interrupt. That residual is accepted — the
      // dialog is gone and the deck is what the user is holding Escape at.
      // Suppressing it would mean a timed "recently closed" window, which is
      // machinery for a gesture nobody makes on purpose.
      if (e.key !== "Escape" || e.repeat) return;
      // Say the press was HANDLED, or it goes on to interrupt the agent this
      // dialog is covering. WebKit raises a `keypress` for Escape, and it is
      // dispatched to whatever holds focus BY THEN — which is the pane's
      // terminal again: this handler closes the dialog, React flushes the
      // unmount in the microtask right after it, and the pane's layout
      // effect takes the keyboard back, all inside this one event. xterm's
      // keypress path sends `String.fromCharCode(27)` to the PTY with no
      // control-character filter of its own. Cancelling the keydown removes
      // the keypress, and with it the write.
      e.preventDefault();
      handler();
    };
    // Bubble, NOT capture — unlike every other Escape listener in the app.
    // Deliberate: a menu inside a dialog (ui-kit's Combobox/Dropdown) closes
    // itself on Escape and stops propagation at the portal container, which
    // is below `window`. From capture this hook would run first and close the
    // whole dialog out from under an open menu.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, handler]);
}

/**
 * Swallow the auto-repeat of a held ENTER for as long as the component is
 * mounted, so one hold activates a focused button exactly once.
 *
 * This has to sit on `keydown`, and it has to cancel: a `<button>` is
 * activated by the ENGINE, as a default action of the `keypress` that is
 * itself a default action of `keydown`. The resulting `click` carries no
 * repeat flag, so nothing downstream — an `onClick`, a listener like
 * [`useEscape`] — can tell the second activation from the first. Cancelling
 * the repeated keydown removes the keypress, and with it the click.
 *
 * Measured in a real browser rather than assumed: with a dialog that mounts a
 * fresh auto-focused button per confirmation, one press plus four OS repeats
 * ran the button FIVE times, and once with this guard. (Space needs no guard
 * — engines activate it on `keyup`, which does not repeat.)
 */
export function useHeldEnterGuard(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.repeat) e.preventDefault();
    };
    // Capture: ahead of anything that might stop propagation first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
