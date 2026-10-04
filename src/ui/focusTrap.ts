const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/** What can take the keyboard by Tab inside `layer`, in order: not what
 * opted out of the Tab order (a combobox's options, tabindex -1), what is
 * disabled (a tabindex does not make a disabled control focusable), a
 * hidden input, or anything hidden or inert, itself or by an ancestor. */
export function tabStops(layer: HTMLElement): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      // A disabled fieldset disables what is in it — said outright, as
      // not every engine's :disabled reaches that far.
      !el.matches(":disabled") &&
      el.closest("fieldset[disabled]") === null &&
      !(el instanceof HTMLInputElement && el.type === "hidden") &&
      el.closest("[hidden], [inert]") === null &&
      shown(el),
  );
}

/** Whether `el` is drawn — no `display: none` or `visibility: hidden` on
 * it or on a box around it. */
function shown(el: HTMLElement): boolean {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/**
 * Where Tab goes inside a modal layer: the index among its `count` tab
 * stops to focus, -1 to keep the keyboard where it is (no stop at all),
 * or null to let the browser take the step — a step that stays inside.
 * `active` is the focused stop's index, -1 when focus is on none of them.
 * The ends wrap: Tab from the last comes back to the first, Shift+Tab from
 * the first to the last — the keyboard never leaves a modal for the inert
 * page behind it (W3C's modal dialog pattern).
 */
export function trappedTab(count: number, active: number, back: boolean): number | null {
  if (count === 0) return -1;
  if (active < 0) return back ? count - 1 : 0;
  if (back && active === 0) return count - 1;
  if (!back && active === count - 1) return 0;
  return null;
}
