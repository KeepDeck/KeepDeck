import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { spawnSession, type Session } from "../session";

interface TerminalPaneProps {
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
  command,
  cwd,
  visible,
  selected,
  onExit,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Held in a ref so the exit handler inside the (command/cwd)-scoped effect
  // always calls the latest callback without re-running the effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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

    spawnSession({ command, cwd, cols: term.cols, rows: term.rows }, (event) => {
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
      session?.close().catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [command, cwd]);

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
