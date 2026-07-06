import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  HINT_MS,
  PaneHintView,
  registerTerminalLinks,
  useTransient,
  type PaneHint,
} from "@keepdeck/terminal-kit";
import { getRuntime } from "../runtime";

/**
 * Read-only log of one run session. xterm is used as a RENDERER here (ANSI
 * colors, progress-bar rewrites, scrollback and selection for free) — this is
 * not the agents' TerminalPane and forwards no input: `disableStdin` and no key
 * binding. The buffer replays on attach, so switching sessions (a remount,
 * keyed by session id) restores what happened before. Links get the shared kit
 * linker — a dev server's URL is the run's main artifact ⌘-clickable — with the
 * opener service's `openUrl`/`openPath` injected.
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
  // Transient notice ([F16]/[U8]) — the ⌘ affordance and failed opens.
  const [hint, showHint] = useTransient<PaneHint>(HINT_MS);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { manager, ctx } = getRuntime();
    let disposed = false;
    let teardown: (() => void) | null = null;

    // Scrollback comes from the host's whitelisted facts so the log feels like
    // the native panes ([F6]); await it BEFORE constructing the Terminal.
    void ctx.host.settings().then(({ terminalScrollback }) => {
      if (disposed || hostRef.current !== host) return;
      const term = new Terminal({
        disableStdin: true,
        scrollback: terminalScrollback,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: { background: "#0b0e14" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      manager.resizeRun(sessionId, term.cols, term.rows);
      const links = registerTerminalLinks(term, host, {
        cwd,
        showHint,
        openUrl: (url) => ctx.services.opener.openUrl(url),
        openPath: (path) => ctx.services.opener.openPath(path),
      });

      const detach = manager.attachRun(sessionId, {
        onOutput: (bytes) => term.write(bytes),
      });
      const observer = new ResizeObserver(() => {
        fit.fit();
        manager.resizeRun(sessionId, term.cols, term.rows);
      });
      observer.observe(host);
      teardown = () => {
        observer.disconnect();
        detach();
        links.dispose();
        term.dispose();
      };
    });

    return () => {
      disposed = true;
      teardown?.();
    };
    // Scrollback is read at construction, like the agent terminals ([F6]);
    // showHint is stable (useTransient); manager/ctx are the activation's
    // stable holders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd]);

  // The inner host is what FitAddon measures — padding lives on the outer box
  // so the text never touches the border, without lying to the fit.
  return (
    <div className="run__log">
      <div ref={hostRef} className="run__log-host" />
      <PaneHintView hint={hint} />
    </div>
  );
}
