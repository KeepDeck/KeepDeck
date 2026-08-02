import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { PaneInputFocusController } from "./paneInputFocusController";

/**
 * Bridges one-shot focus requests to a pane's imperative input surface after
 * React has committed it. inputVersion changes whenever that surface is rebuilt.
 */
export function usePaneInputFocus(
  controller: PaneInputFocusController,
  paneId: string,
  active: boolean,
  inputVersion: number,
  focusInput: () => void,
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
  }, [active, focusInput, inputVersion, paneId, request]);
}
