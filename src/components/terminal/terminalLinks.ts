import type { Terminal } from "@xterm/xterm";
import {
  registerTerminalLinks as registerKitLinks,
  type PaneHint,
} from "@keepdeck/terminal-kit";
import type {
  FileOpenManager,
  FileOpenOutcome,
} from "../../app/fileOpenManager";

/** Where link activation lands: cwd for relative paths, hints for feedback.
 * The kit's provider takes URL opening on the target; the app binds that
 * capability before this wrapper sees it. */
export interface TerminalLinkTarget {
  /** Working dir resolving relative path links; null resolves against the
   * app's cwd (the backend's default). */
  cwd: string | null;
  /** Transient in-surface feedback (the ⌘ affordance, a failed open),
   * anchored at surface-local coordinates. */
  showHint(hint: PaneHint): void;
  openUrl(url: string): Promise<void>;
}

/**
 * Cmd+click a URL or file path in the output to open it ([F14]/[F10]) —
 * shared by every host xterm surface (agent panes, the Run log). The
 * behaviour lives in @keepdeck/terminal-kit; this thin adapter is the host
 * call site that binds URLs to the browser and file paths to the
 * app runtime's file-open chain (plugin handlers first, the OS default app as the
 * floor). When a handler declined and the system opener took the file, the
 * click gets a hint saying so — routing never silently contradicts an
 * enabled in-app opener.
 */
export function registerTerminalLinks(
  term: Terminal,
  host: HTMLElement,
  target: TerminalLinkTarget,
  fileOpen: FileOpenManager,
): { dispose(): void } {
  return registerKitLinks(term, host, {
    ...target,
    openPath: async (path) => linkOpenNotice(await fileOpen.open({ path })),
  });
}

/** What the click should say for a chain outcome: an in-app handler declined
 * and the SYSTEM opener took the file → "Opened externally" (routing never
 * silently contradicts an enabled in-app opener); every other outcome —
 * handled in-app, or system with nothing registered — stays silent. Pure,
 * exported for its unit test: this one branch is the seam's whole behavior. */
export function linkOpenNotice(
  outcome: FileOpenOutcome,
): { notice: string } | undefined {
  return outcome.declined && outcome.via === "system"
    ? { notice: "Opened externally" }
    : undefined;
}
