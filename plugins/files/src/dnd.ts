/**
 * The dataTransfer MIME a dragged tree row's file path travels under. The host
 * recognizes exactly this type on a drop over a pane and writes the path into
 * that pane's PTY (see `src/app/dragDrop.ts` `PANE_PATH_DROP_TYPE` and
 * `usePaneDrop`). A dedicated type — not text/plain — so only an intentional
 * file drag delivers into a terminal. This literal MUST match the host's; the
 * two are the drag contract between the plugin and the host.
 */
export const PANE_PATH_DROP_TYPE = "application/x-keepdeck-path";
