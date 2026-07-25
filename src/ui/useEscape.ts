import { useEffect } from "react";

/** Invoke `handler` whenever Escape is pressed while the component is mounted. */
export function useEscape(handler: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A HELD key repeats, and one dismissal must not stand for the next
      // dialog's: notices queue, so a repeat would pop one the user never
      // saw. One press, one dismissal.
      if (e.key === "Escape" && !e.repeat) handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handler]);
}
