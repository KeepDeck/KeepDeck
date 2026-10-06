/** Whether a key event's target is somewhere text is typed — a field, an
 * area, an editable region: there a letter is text, never a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, [contenteditable='true']") !== null;
}
