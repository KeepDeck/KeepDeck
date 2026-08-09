/**
 * Blur `element`, but only when it is what currently holds the keyboard.
 *
 * The guard IS the function. A release runs on the edge where a surface stops
 * being allowed the keyboard, and by then something else may already hold it —
 * the dialog that caused the edge, or the pane being selected in the same
 * commit. Blurring then takes the keyboard from the surface the user is
 * actually looking at, which is worse than not releasing at all.
 *
 * It is also what makes the release harmless on the paths where the engine got
 * there first: clicking any chrome button drops focus before the click
 * handler runs, and an `inert` background blurs its subtree, so most releases
 * find nothing of theirs to give back and correctly do nothing.
 */
export function releaseKeyboard(element: HTMLElement | null | undefined): void {
  if (element && element.ownerDocument.activeElement === element) {
    element.blur();
  }
}
