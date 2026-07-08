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
 * Log of one run session. xterm is used as a RENDERER here (ANSI colors,
 * progress-bar rewrites, scrollback and selection for free). The buffer replays
 * on attach, so switching sessions (a remount, keyed by session id) restores
 * what happened before. Links get the shared kit linker — a dev server's URL is
 * the run's main artifact ⌘-clickable — with the opener service's
 * `openUrl`/`openPath` injected.
 *
 * READ-ONLY BY DEFAULT (`interactive` false): stdin disabled, no cursor, no
 * keystroke forwarded — the log stays a copyable artifact that can't be typed
 * into by accident. When the caption's input toggle ARMS the session
 * (`interactive` true, offered only while it runs), stdin opens and keystrokes
 * flow straight to the PTY (answer a `(Y/n)` prompt, Ctrl-C, arrows, a full
 * TUI) — gated further by focus, since xterm needs the focus to receive keys.
 * Input goes through the manager's `writeRun`, which no-ops once the process
 * exits. Arming is toggled on the LIVE terminal below, never by a rebuild — a
 * rebuild would drop the scrollback.
 */
export function RunLog({
  sessionId,
  cwd,
  interactive = false,
}: {
  sessionId: string;
  /** The run's worktree — relative path links in its output resolve here. */
  cwd: string;
  /** Armed for input: stdin open, keystrokes forwarded to the PTY. Off = the
   * read-only default. Applied live, without rebuilding the terminal. */
  interactive?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Read inside the stable onData handler so toggling input never re-subscribes,
  // and so a keystroke during the async construction gap still sees the latest.
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
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
        // Read-only unless armed; both are runtime options the `interactive`
        // effect below re-applies when the toggle flips on a live terminal.
        disableStdin: !interactiveRef.current,
        cursorBlink: interactiveRef.current,
        scrollback: terminalScrollback,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: { background: "#0b0e14" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      termRef.current = term;
      manager.resizeRun(sessionId, term.cols, term.rows);
      const links = registerTerminalLinks(term, host, {
        cwd,
        showHint,
        openUrl: (url) => ctx.services.opener.openUrl(url),
        openPath: (path) => ctx.services.opener.openPath(path),
      });

      // Forward keystrokes to the PTY only while armed — double-gated with
      // `disableStdin` (a paste can reach onData even when stdin is off).
      const input = term.onData((data) => {
        if (interactiveRef.current) manager.writeRun(sessionId, data);
      });

      const detach = manager.attachRun(sessionId, {
        onOutput: (bytes) => term.write(bytes),
      });
      const observer = new ResizeObserver(() => {
        fit.fit();
        manager.resizeRun(sessionId, term.cols, term.rows);
      });
      observer.observe(host);
      // Armed already at construction (rare — arming normally follows mount):
      // take focus so the prompt is answerable without a click first.
      if (interactiveRef.current) term.focus();
      teardown = () => {
        observer.disconnect();
        input.dispose();
        detach();
        links.dispose();
        term.dispose();
        termRef.current = null;
      };
    });

    return () => {
      disposed = true;
      teardown?.();
    };
    // Scrollback/interactive are read at construction via refs; arming is
    // applied to the live terminal by the effect below WITHOUT a rebuild (which
    // would drop the scrollback). showHint is stable (useTransient);
    // manager/ctx are the activation's stable holders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd]);

  // Arm / disarm the LIVE terminal without rebuilding it: open or close stdin,
  // show or hide the cursor, and take focus when newly armed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !interactive;
    term.options.cursorBlink = interactive;
    if (interactive) term.focus();
  }, [interactive]);

  // The inner host is what FitAddon measures — padding lives on the outer box
  // so the text never touches the border, without lying to the fit.
  return (
    <div className="run__log">
      <div ref={hostRef} className="run__log-host" />
      <PaneHintView hint={hint} />
    </div>
  );
}
