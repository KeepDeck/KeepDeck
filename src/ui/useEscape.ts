import { useEffect } from "react";

/** Invoke `handler` whenever Escape is pressed while the component is mounted. */
export function useEscape(handler: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A HELD key repeats, and one dismissal must not stand for the next
      // dialog's: notices queue, so a repeat would pop one the user never
      // saw. One press, one dismissal. A repeat is left UNTOUCHED rather
      // than swallowed — by the time it arrives this surface is gone, and
      // the key belongs to whatever holds the keyboard then.
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handler]);
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
