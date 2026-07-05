import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { attachRun, resizeRun } from "../../app/runManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { useTransient } from "../../ui/useTransient";
import { HINT_MS, PaneHintView, type PaneHint } from "../terminal/PaneHint";
import { registerTerminalLinks } from "../terminal/terminalLinks";

/**
 * Read-only log of one run session. xterm is used as a RENDERER here (ANSI
 * colors, progress-bar rewrites, scrollback and selection for free) — this
 * is not the agents' TerminalPane and forwards no input: `disableStdin` and
 * no key binding. The buffer replays on attach, so switching sessions (a
 * remount, keyed by session id) restores what happened before. Links get the
 * shared linker — a dev server's URL is the run's main artifact ⌘-clickable.
 */
export function RunLog({
  sessionId,
  cwd,
}: {
  sessionId: string;
  /** The run's worktree — relative path links in its output resolve here. */
  cwd: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollback = useSettings()?.scrollback ?? DEFAULT_SETTINGS.scrollback;
  // Transient notice ([F16]/[U8]) — the ⌘ affordance and failed opens.
  const [hint, showHint] = useTransient<PaneHint>(HINT_MS);

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
    const links = registerTerminalLinks(term, host, { cwd, showHint });

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
      links.dispose();
      term.dispose();
    };
    // Scrollback is read at construction, like the agent terminals ([F6]);
    // showHint is stable (useTransient).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd]);

  // The inner host is what FitAddon measures — padding lives on the outer
  // box so the text never touches the border, without lying to the fit.
  return (
    <div className="run__log">
      <div ref={hostRef} className="run__log-host" />
      <PaneHintView hint={hint} />
    </div>
  );
}
