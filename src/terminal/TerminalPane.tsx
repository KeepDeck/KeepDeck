import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  /** Client-side text shown on mount. PTY streaming replaces this later. */
  banner?: string;
}

/**
 * A single terminal pane.
 *
 * The skeleton only renders a client-side banner — there is no PTY behind it
 * yet. Spawning a real agent and streaming its output (the PTY base lifted from
 * AnyClaude) lands in a later step; the observability-tap reads that stream.
 */
export function TerminalPane({ banner }: TerminalPaneProps) {
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

    if (banner) term.writeln(banner);

    const refit = () => fit.fit();
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    window.addEventListener("resize", refit);

    return () => {
      window.removeEventListener("resize", refit);
      observer.disconnect();
      term.dispose();
    };
  }, [banner]);

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
