import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { attachRun, resizeRun } from "../../app/runManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";

/**
 * Read-only log of one run session. xterm is used as a RENDERER here (ANSI
 * colors, progress-bar rewrites, scrollback and selection for free) — this
 * is not the agents' TerminalPane and forwards no input: `disableStdin` and
 * no key binding. The buffer replays on attach, so switching sessions (a
 * remount, keyed by session id) restores what happened before.
 */
export function RunLog({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollback = useSettings()?.scrollback ?? DEFAULT_SETTINGS.scrollback;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      disableStdin: true,
      scrollback,
      fontSize: 11,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0b0e14" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    resizeRun(sessionId, term.cols, term.rows);

    const detach = attachRun(sessionId, {
      onOutput: (bytes) => term.write(bytes),
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      resizeRun(sessionId, term.cols, term.rows);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      detach();
      term.dispose();
    };
    // Scrollback is read at construction, like the agent terminals ([F6]).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return <div ref={hostRef} className="run__log" />;
}
