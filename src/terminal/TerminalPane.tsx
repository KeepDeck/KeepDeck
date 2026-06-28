import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { spawnSession, type Session } from "../session";

interface TerminalPaneProps {
  /** Program to run in the pane; omitted/null spawns the user's shell. */
  command?: string | null;
}

/**
 * A single terminal pane backed by a live PTY session. On mount it spawns a
 * session, pipes the PTY output into xterm and keystrokes back to the PTY, and
 * keeps the PTY size in sync with the pane. On unmount it closes the session.
 */
export function TerminalPane({ command }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);

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
    void loadWebglAddon(term);
    fit.fit();

    let session: Session | null = null;
    let disposed = false;

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

    const refit = () => {
      fit.fit();
      session?.resize(term.cols, term.rows).catch(() => {});
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
    };
  }, [command]);

  return <div className="terminal-pane" ref={hostRef} />;
}

/** WebGL renderer is an optimization; fall back silently to the default. */
async function loadWebglAddon(term: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    term.loadAddon(new WebglAddon());
  } catch {
    // Canvas/DOM renderer is fine when WebGL is unavailable.
  }
}
