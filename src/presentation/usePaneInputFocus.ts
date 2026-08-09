import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { PaneInputFocusSource } from "./paneInputFocusController";

/**
 * Bridges one-shot focus requests to a pane's imperative input surface after
 * React has committed it. inputVersion changes whenever that surface is rebuilt.
 *
 * `active` is the whole answer to "may this pane hold the keyboard", so it is
 * read in BOTH directions. Only taking focus was the older reading, and it
 * made the flag a half-truth: a pane that already had the keyboard when a
 * covering surface appeared went on answering every key, because nothing ever
 * asked it to let go. `releaseInput` is that missing verb — the view decides
 * whether the keyboard is still its to release, since only the view knows
 * which element is its own.
 */
export function usePaneInputFocus(
  controller: PaneInputFocusSource,
  paneId: string,
  active: boolean,
  inputVersion: number,
  focusInput: () => void,
  releaseInput: () => void,
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
    if (becameActive || inputChanged || explicitlyRequested) focusInput();
    // Never both: every take requires `active`, and this is its edge away.
    if (becameInactive) releaseInput();
  }, [active, focusInput, inputVersion, paneId, releaseInput, request]);
}
