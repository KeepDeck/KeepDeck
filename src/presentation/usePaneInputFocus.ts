import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { PaneInputFocusSource } from "./paneInputFocusController";

/**
 * A pane's keyboard, as the two verbs this hook drives.
 *
 * One object rather than two positional callbacks: both are `() => void`, so a
 * transposition type-checks and silently inverts the policy — the pane would
 * take the keyboard exactly when it was told to give it up.
 */
export interface PaneKeyboard {
  /** Put the keyboard in this pane's input surface. */
  take(): void;
  /** Give it back, if this pane is still the one holding it. */
  release(): void;
}

/**
 * Bridges one-shot focus requests to a pane's imperative input surface after
 * React has committed it. inputVersion changes whenever that surface is rebuilt.
 *
 * `active` is read in BOTH directions. Whether a pane may hold the keyboard is
 * DECIDED upstream, in `keyboardFocusEnabled`; this hook is one of the two
 * things that enforce that decision, the other being the `inert` background a
 * modal layer puts up. Neither is the decision, and neither subsumes the
 * other: `inert` reaches everything a DOM layer stands over but exists only
 * where there is such a layer, and this reaches the pane wherever the flag
 * goes false. Taking focus used to be the whole of it, which left the flag a
 * half-truth — a pane that already had the keyboard went on answering every
 * key, because nothing ever asked it to let go.
 */
export function usePaneInputFocus(
  controller: PaneInputFocusSource,
  paneId: string,
  active: boolean,
  inputVersion: number,
  keyboard: PaneKeyboard,
) {
  const request = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const previous = useRef({ active: false, inputVersion });
  const handledRequestVersion = useRef(0);

  useLayoutEffect(() => {
    const becameActive = active && !previous.current.active;
    const becameInactive = !active && previous.current.active;
    const inputChanged =
      active && previous.current.inputVersion !== inputVersion;
    const explicitlyRequested =
      active &&
      request.paneId === paneId &&
      handledRequestVersion.current !== request.version;

    previous.current = { active, inputVersion };
    if (explicitlyRequested) {
      handledRequestVersion.current = request.version;
    }
    if (becameActive || inputChanged || explicitlyRequested) keyboard.take();
    // Never both: every take requires `active`, and this is its edge away.
    if (becameInactive) keyboard.release();
  }, [active, inputVersion, keyboard, paneId, request]);
}
