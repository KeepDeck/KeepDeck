import type { Terminal } from "@xterm/xterm";
import {
  registerTerminalLinks as registerKitLinks,
  type PaneHint,
} from "@keepdeck/terminal-kit";
import { openPath, openUrl } from "../../ipc/app";

/** Where link activation lands: cwd for relative paths, hints for feedback.
 * The kit's provider is ipc-inverted (it takes `openUrl`/`openPath` on the
 * target); this host wrapper binds those to the app's Tauri ipc once, so every
 * host call site keeps the small `{ cwd, showHint }` shape it always had. */
export interface TerminalLinkTarget {
  /** Working dir resolving relative path links; null resolves against the
   * app's cwd (the backend's default). */
  cwd: string | null;
  /** Transient in-surface feedback (the ⌘ affordance, a failed open),
   * anchored at surface-local coordinates. */
  showHint(hint: PaneHint): void;
}

/**
 * Cmd+click a URL or file path in the output to open it ([F14]/[F10]) —
 * shared by every host xterm surface (agent panes, the Run log). The behaviour
 * lives in @keepdeck/terminal-kit; this thin adapter is the host call site that
 * supplies the opener primitives (`openUrl`/`openPath`) from `../../ipc/app`.
 */
export function registerTerminalLinks(
  term: Terminal,
  host: HTMLElement,
  target: TerminalLinkTarget,
): { dispose(): void } {
  return registerKitLinks(term, host, { ...target, openUrl, openPath });
}
