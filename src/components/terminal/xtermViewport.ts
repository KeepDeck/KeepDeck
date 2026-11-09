import type { Terminal } from "@xterm/xterm";
import { isObjectLike } from "../../domain/json";

/**
 * Bring xterm's scrollbar back in line with its buffer.
 *
 * xterm sizes its native scroll area from the viewport element's laid-out
 * height, on a frame of its own, whenever output adds lines — also while the
 * terminal is out of layout (a minimized or maximized-away pane, a background
 * workspace) or at 0px mid-re-tile. There the height reads 0: the area comes
 * out a screen short and the scroll position is never set. Shown again, WebKit
 * clamps the scroll position to that short area while the buffer still stands
 * where it was, so the wheel cannot reach the history, and its first move pulls
 * the buffer to the clamped row — until the next line of output re-syncs it.
 * Nothing public re-syncs a terminal whose grid did not change: `fit()` skips an
 * unchanged grid, and `refresh()` repaints rows only.
 *
 * `syncScrollArea(true)` is what xterm itself runs after a resize. It measures
 * again only when what it recorded differs from now, which a measure taken at
 * height 0 always does, so a call on a terminal in good order costs a few
 * comparisons. The viewport is private: read key by key, it is a no-op on an
 * xterm that keeps it elsewhere, and `xtermViewport.test.ts` holds the place
 * against the installed xterm, so an upgrade that moves it fails there.
 */
export function syncScrollArea(term: Terminal): void {
  const core: unknown = Reflect.get(term, "_core");
  const viewport = isObjectLike(core) ? core.viewport : undefined;
  if (!isObjectLike(viewport)) return;
  const sync = viewport.syncScrollArea;
  if (typeof sync === "function") Reflect.apply(sync, viewport, [true]);
}
