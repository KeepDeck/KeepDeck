import { useEffect } from "react";

/** Invoke `handler` on ⌘S/Ctrl+S while the component is mounted (the
 * browser's save dialog is always suppressed). Matches the PHYSICAL key
 * (`e.code`), not the layout-mapped character — on a Cyrillic layout the S
 * key yields "ы" and a `key` match would never fire; borrowed from
 * `isCopyChord` (domain/terminal/clipboard.ts), physical-code half only:
 * extra modifiers (⇧/⌥) are deliberately NOT excluded here, a decorated
 * save chord just saves. Same shape as `useEscape`: the handler is
 * re-registered per render, so it never closes over stale state — do not
 * "optimize" the deps to `[]`. */
export function useSaveShortcut(handler: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyS") {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handler]);
}
