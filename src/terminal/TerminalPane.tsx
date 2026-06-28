import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { spawnSession, type Session } from "../session";

interface TerminalPaneProps {
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Whether this pane's workspace is currently visible. */
  active: boolean;
}

/**
 * A single terminal pane backed by a live PTY session. On mount it spawns a
 * session, pipes the PTY output into xterm and keystrokes back to the PTY, and
 * keeps the PTY size in sync with the pane. On unmount it closes the session.
 */
export function TerminalPane({ command, active }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0b0e14", foreground: "#c5c8c6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    loadWebglRenderer(term);
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

    spawnSession({ command, cols: term.cols, rows: term.rows }, (event) => {
      if (event.type === "output") {
        term.write(new Uint8Array(event.bytes));
      } else {
        const suffix = event.code !== null ? ` (${event.code})` : "";
        term.writeln(`\r\n\x1b[90m[process exited${suffix}]\x1b[0m`);
      }
    })
      .then((s) => {
        if (disposed) {
          void s.close();
        } else {
          session = s;
        }
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
  }, [command]);

  // When the pane's workspace becomes visible again, repaint from the buffer so
  // nothing is left blank after a switch (e.g. if its GPU context was dropped).
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    fitRef.current?.fit();
    term?.refresh(0, term.rows - 1);
  }, [active]);

  return <div className="terminal-pane" ref={hostRef} />;
}

/**
 * Render on the GPU via WebGL. The cockpit can show up to 16 panes, which sits
 * at the browser's WebGL context limit, so a context can get evicted — on loss
 * we dispose the addon and xterm falls back to its default renderer for that
 * pane (no blank canvas). WebGL being unavailable at all is handled the same way.
 */
function loadWebglRenderer(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL — the default renderer is used.
  }
}
