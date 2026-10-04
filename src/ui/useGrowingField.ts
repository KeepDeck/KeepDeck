import { useLayoutEffect, type RefObject } from "react";

/**
 * A text field as tall as what is typed in it — one line while it is one
 * line, a line more for each line more, up to its CSS `max-height`, after
 * which it scrolls. WebKit has no `field-sizing: content`, so the height is
 * measured: collapsed to `auto`, then set to the content's scroll height
 * plus the box's own edges (the field is `border-box`). Its `min-height`
 * keeps the one-line size; the stylesheet keeps the bounds.
 */
export function useGrowingField(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  // In the layout phase: the frame painted already has the new height.
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    const edges = field.offsetHeight - field.clientHeight;
    field.style.height = `${field.scrollHeight + edges}px`;
  }, [ref, value]);
}
