import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { spawnSession, type Session } from "../session";
import { openPath, openUrl, copyText } from "../ipc";
import { registerPaneInput } from "./paneInput";
import { keyAction } from "../domain/keymap";
import { isCopyChord, normalizeSelection } from "../domain/clipboard";
import { detectLinks, resolvePathTarget } from "../domain/links";

interface TerminalPaneProps {
  /** Pane id — routes window-level input (drag-and-drop) to this session. */
  paneId: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Working directory for the session; omitted uses the app's cwd. */
  cwd?: string | null;
  /** Whether this pane is currently on screen (active workspace, not collapsed). */
  visible: boolean;
  /** The highlighted pane — focus its terminal when it's on screen. */
  selected?: boolean;
  /** Called when the PTY process exits, with its exit code (null if unknown).
   * Lets the pane show an "agent exited" placeholder ([U4]). */
  onExit?: (code: number | null) => void;
  /** Called when the terminal title changes (OSC 0/1/2) — drives auto-naming
   * ([F11]). */
  onTitle?: (title: string) => void;
}

/**
 * A single terminal pane backed by a live PTY session. On mount it spawns a
 * session, pipes the PTY output into xterm and keystrokes back to the PTY, and
 * keeps the PTY size in sync with the pane. On unmount it closes the session.
 *
 * Renderer: xterm's default (canvas/DOM), NOT WebGL. A WebGL context per pane
 * was measured to behave worse across a grid of panes (the browser's ~16
 * context limit causes eviction/blanking), so GPU rendering is off for now —
 * revisit only if profiling a single pane shows the default renderer is a bottleneck.
 */
export function TerminalPane({
  paneId,
  command,
  cwd,
  visible,
  selected,
  onExit,
  onTitle,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Held in a ref so the exit handler inside the (command/cwd)-scoped effect
  // always calls the latest callback without re-running the effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      // xterm defaults to 1000 lines — too small for verbose agents. Bumped;
      // make it configurable later (settings, [F6]).
      scrollback: 10000,
      theme: { background: "#0b0e14", foreground: "#c5c8c6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    loadCanvasRenderer(term);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let session: Session | null = null;
    let disposed = false;
    let lastCols = term.cols;
    let lastRows = term.rows;

    const input = term.onData((data) => {
      session?.write(data).catch(() => {});
    });

    // Own terminal copy. Canvas-rendered text isn't DOM-selectable and WKWebView
    // returns "" from getSelection() during a keydown, so the native Cmd+C copies
    // the stale hidden textarea (garbage). Cache the selection on change and read
    // the cache in the handler, then write it to the native pasteboard.
    let selection = "";
    const selectionSub = term.onSelectionChange(() => {
      selection = term.getSelection();
    });
    const copySelection = () => {
      const text = normalizeSelection(selection || term.getSelection());
      if (text) copyText(text).catch(() => {});
    };

    // Override select keys before xterm encodes them — Cmd+C → copy the selection
    // ourselves; Shift+Enter → newline ([F3]); everything else falls through.
    term.attachCustomKeyEventHandler((e) => {
      if (isCopyChord(e) && term.hasSelection()) {
        copySelection();
        e.preventDefault();
        return false; // owned — don't let WKWebView copy the (garbage) textarea
      }
      const { send, block } = keyAction(e);
      if (send) session?.write(send).catch(() => {});
      if (block) {
        e.preventDefault();
        return false; // handled — don't let xterm emit its default (CR)
      }
      return true;
    });

    // The macOS Edit-menu Copy and right-click Copy fire a native `copy` event
    // (no keydown), so fill it with the real selection too — otherwise those
    // paths hit the same garbage.
    const onCopy = (ev: ClipboardEvent) => {
      if (!term.hasSelection()) return;
      const text = normalizeSelection(term.getSelection());
      if (!text) return;
      ev.clipboardData?.setData("text/plain", text);
      ev.preventDefault();
    };
    host.addEventListener("copy", onCopy);

    // Layer 2 for [F3]: stop the textarea inserting a literal newline on
    // Shift+Enter before xterm's handler runs (capture phase). Without this the
    // browser's own default can put a \n into the helper textarea.
    const ta = term.textarea;
    const blockShiftEnterDefault = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
      }
    };
    ta?.addEventListener("keydown", blockShiftEnterDefault, true);

    // Route window-level input (a dropped file path, [F4]) into this session.
    const unregister = registerPaneInput(paneId, (text) => {
      session?.write(text).catch(() => {});
    });

    // Auto-naming ([F11]): mirror the terminal title (OSC 0/1/2) up to the pane.
    const titleSub = term.onTitleChange((t) => onTitleRef.current?.(t));

    // Cmd+click a URL or file path in the output to open it ([F14]/[F10]);
    // plain click is left for text selection. Relative paths resolve against the
    // pane's cwd; the OS default app opens files / the default browser opens URLs.
    const links = term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const text = term.buffer.active
          .getLine(lineNumber - 1)
          ?.translateToString(true);
        const found = text ? detectLinks(text) : [];
        callback(
          found.length === 0
            ? undefined
            : found.map((d) => ({
                text: d.text,
                range: {
                  start: { x: d.start + 1, y: lineNumber },
                  end: { x: d.end, y: lineNumber },
                },
                activate(event: MouseEvent) {
                  if (!event.metaKey) return;
                  const open =
                    d.kind === "url"
                      ? openUrl(d.text)
                      : openPath(resolvePathTarget(d.text, cwd ?? ""));
                  open.catch(() => {});
                },
              })),
        );
      },
    });

    spawnSession({ command, cwd, cols: term.cols, rows: term.rows }, (event) => {
      // Ignore events from a session whose pane was already torn down — notably
      // the throwaway first session of a StrictMode double-mount, whose close()
      // emits an exit (code 1) that would otherwise flash the [U4] "agent
      // exited" placeholder over the live agent. Also avoids writing to a
      // disposed terminal.
      if (disposed) return;
      if (event.type === "output") {
        term.write(new Uint8Array(event.bytes));
      } else {
        const suffix = event.code !== null ? ` (${event.code})` : "";
        term.writeln(`\r\n\x1b[90m[process exited${suffix}]\x1b[0m`);
        onExitRef.current?.(event.code);
      }
    })
      .then((s) => {
        if (disposed) {
          void s.close();
          return;
        }
        session = s;
        // Sync the PTY to the current grid. A ResizeObserver can fire while the
        // spawn promise is pending (sibling panes mounting) — it advances the
        // lastCols/lastRows watermark but its `session?.resize` is a no-op
        // (session still null), leaving the PTY stuck at the spawn size while
        // xterm grew. That desync is what leaves blank rows + a phantom scroll
        // (and garbles TUI repaints). Resize unconditionally now to converge.
        lastCols = term.cols;
        lastRows = term.rows;
        s.resize(term.cols, term.rows).catch(() => {});
      })
      .catch((err: unknown) => {
        term.writeln(`\r\n\x1b[31m[failed to start session: ${err}]\x1b[0m`);
      });

    // Refit, and only resize the PTY when the cell grid actually changed — a
    // redundant SIGWINCH makes the shell reprint its prompt.
    const refit = () => {
      fit.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        session?.resize(term.cols, term.rows).catch(() => {});
      }
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    window.addEventListener("resize", refit);

    return () => {
      disposed = true;
      window.removeEventListener("resize", refit);
      observer.disconnect();
      input.dispose();
      unregister();
      links.dispose();
      titleSub.dispose();
      selectionSub.dispose();
      host.removeEventListener("copy", onCopy);
      ta?.removeEventListener("keydown", blockShiftEnterDefault, true);
      session?.close().catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [command, cwd, paneId]);

  // When the pane comes back on screen (workspace switch, or un-maximized),
  // refit and repaint from the buffer so nothing is left blank.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    fitRef.current?.fit();
    term?.refresh(0, term.rows - 1);
    // Move keyboard focus to the highlighted pane when it comes on screen (e.g.
    // after a workspace switch), so you can type without clicking first ([B2]).
    if (selected) term?.focus();
  }, [visible, selected]);

  return <div className="terminal-pane" ref={hostRef} />;
}

/**
 * Render via the 2D canvas addon. The DOM renderer draws box-drawing characters
 * (agent UIs like Claude Code's frames) with gaps between cells; the canvas
 * renderer draws them as connected lines and is crisper. Unlike WebGL it doesn't
 * hit the browser's ~16 GPU-context limit across a grid of panes.
 */
function loadCanvasRenderer(term: Terminal): void {
  try {
    term.loadAddon(new CanvasAddon());
  } catch {
    // Canvas unavailable — xterm's DOM renderer is used.
  }
}
