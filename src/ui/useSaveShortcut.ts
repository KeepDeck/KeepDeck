import { useEffect } from "react";

/** Invoke `handler` on ⌘S/Ctrl+S while the component is mounted (the
 * browser's save dialog is always suppressed). Same shape as `useEscape`:
 * the handler is re-registered per render, so it never closes over stale
 * state — do not "optimize" the deps to `[]`. */
export function useSaveShortcut(handler: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handler]);
}
