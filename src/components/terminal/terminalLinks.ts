import type { Terminal } from "@xterm/xterm";
import {
  detectLinks,
  logicalLineAt,
  mapRange,
  openErrorHint,
  resolvePathTarget,
} from "../../domain/terminal";
import { openPath, openUrl } from "../../ipc/app";
import type { PaneHint } from "./PaneHint";

/** Where link activation lands: cwd for relative paths, hints for feedback. */
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
 * shared by every xterm surface (agent panes, the Run log); plain click is
 * left for text selection (a plain click ON a link shows the ⌘ hint, [U8]).
 * Relative paths resolve against the surface's cwd; the OS default app opens
 * files / the default browser opens URLs. Detection runs on the whole LOGICAL
 * line — the requested row joined with its wrapped neighbours — so a link the
 * terminal wrapped is still one link, not per-row fragments.
 *
 * `host` anchors hint coordinates: the element xterm is mounted in, whose
 * offset parent renders the PaneHintView.
 */
export function registerTerminalLinks(
  term: Terminal,
  host: HTMLElement,
  target: TerminalLinkTarget,
): { dispose(): void } {
  return term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const logical = logicalLineAt(term.buffer.active, lineNumber - 1);
      const found = logical ? detectLinks(logical.rows.join("")) : [];
      callback(
        found.length === 0 || !logical
          ? undefined
          : found.map((d) => ({
              text: d.text,
              range: mapRange(logical, d.start, d.end),
              activate(event: MouseEvent) {
                // Surface-local coords captured now, at click-time geometry,
                // not when a rejection lands later.
                const rect = host.getBoundingClientRect();
                const at = {
                  x: event.clientX - rect.left,
                  y: event.clientY - rect.top,
                };
                // The ⌘ affordance is undiscoverable — answer a plain (or
                // wrong-modifier) click on a link with how to open it ([U8]).
                if (!event.metaKey) {
                  target.showHint({ text: "⌘-click to open", ...at });
                  return;
                }
                const dest =
                  d.kind === "url"
                    ? d.text
                    : resolvePathTarget(d.text, target.cwd ?? "");
                const open = d.kind === "url" ? openUrl(dest) : openPath(dest);
                // Surface the failure — a deleted file, a bad URL — next to
                // the link that was clicked instead of swallowing it ([F16]).
                open.catch((err: unknown) =>
                  target.showHint({ text: openErrorHint(err, dest), ...at }),
                );
              },
            })),
      );
    },
  });
}
