// The app renders its own UI for every interaction, so the WKWebView context
// menus (Cut/Copy/Paste over inputs, Reload elsewhere) don't belong in the
// product — suppress them wholesale. Clipboard use inside terminals is already
// covered by Cmd+C/Cmd+V. A future in-app context menu renders custom DOM and
// is unaffected by this.
//
// The listener is installed in the capture phase so it runs before any
// component handler that might stop propagation (e.g. inside xterm).
export function suppressNativeContextMenu(
  target: EventTarget = document,
): () => void {
  const block = (event: Event) => event.preventDefault();
  target.addEventListener("contextmenu", block, { capture: true });
  return () =>
    target.removeEventListener("contextmenu", block, { capture: true });
}
