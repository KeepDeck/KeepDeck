import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import {
  acquirePane,
  attachPane,
  resizePane,
  writePane,
} from "../../app/ptyManager";
import { openPath, openUrl } from "../../ipc/app";
import { readImageTempPath, readText, writeText } from "../../ipc/clipboard";
import { registerPaneInput } from "../../app/paneInput";
import { keyAction } from "../../domain/keymap";
import {
  createPasteHandler,
  isCopyChord,
  normalizeSelection,
  osc52Text,
} from "../../domain/clipboard";
import {
  detectLinks,
  openErrorHint,
  resolvePathTarget,
} from "../../domain/links";
import { createRefitPump } from "../../domain/refitPump";
import { logicalLineAt, mapRange } from "../../domain/wrappedLines";
import { useTransient } from "../../ui/useTransient";
import { positionHint } from "../../ui/hintPosition";

interface TerminalPaneProps {
  /** Pane id — routes window-level input (drag-and-drop) to this session. */
  paneId: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Extra CLI args for the program — session identity / resume ([F7]/[F8]).
   * Read once at spawn time; later changes never restart a live session. */
  args?: string[];
  /** Extra environment for the program — reporter activation ([F7]/[F8]).
   * Read once at spawn time, like `args`. */
  env?: [string, string][];
  /** Working directory for the session; omitted uses the app's cwd. */
  cwd?: string | null;
  /** Scrollback lines to keep ([F6]); changes apply to the live terminal. */
  scrollback: number;
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
 * A single terminal pane — a VIEW over a PTY session the `ptyManager` owns.
 * On mount it acquires the pane's session (idempotent — an existing one is
 * reused, with recent output replayed) and attaches xterm to it; keystrokes
 * flow back through the manager. On unmount it only detaches: the process
 * keeps running, and dies solely through the deck's explicit close actions.
 *
 * Renderer: xterm's default (canvas/DOM), NOT WebGL. A WebGL context per pane
 * was measured to behave worse across a grid of panes (the browser's ~16
 * context limit causes eviction/blanking), so GPU rendering is off for now —
 * revisit only if profiling a single pane shows the default renderer is a bottleneck.
 */
export function TerminalPane({
  paneId,
  command,
  args,
  env,
  cwd,
  scrollback,
  visible,
  selected,
  onExit,
  onTitle,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Transient in-pane notice ([F16]) — "File not found" after a Cmd+click on a
  // stale path (or a failed open). Self-clears; anchored to the click point.
  const [hint, showHint] = useTransient<PaneHint>(HINT_MS);
  const hintRef = useRef<HTMLDivElement>(null);

  // Position the hint once its size is measurable — before paint, so it never
  // flashes at the wrong spot. Re-runs per show (each hint is a fresh object).
  useLayoutEffect(() => {
    const el = hintRef.current;
    const pane = el?.parentElement;
    if (!el || !pane || !hint) return;
    const pos = positionHint(
      hint,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: pane.clientWidth, height: pane.clientHeight },
    );
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  }, [hint]);

  // Held in a ref so the exit handler inside the (command/cwd)-scoped effect
  // always calls the latest callback without re-running the effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  // Args/env matter only at spawn time — refs keep them out of the effect
  // deps so a later change can't tear down and restart a live session.
  const argsRef = useRef(args);
  argsRef.current = args;
  const envRef = useRef(env);
  envRef.current = env;
  // Scrollback seeds construction through a ref for the same reason; a live
  // change is applied by its own effect below, not by a terminal rebuild.
  const scrollbackRef = useRef(scrollback);
  scrollbackRef.current = scrollback;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      // xterm defaults to 1000 lines — too small for verbose agents. The
      // value is the [F6] setting.
      scrollback: scrollbackRef.current,
      theme: { background: "#0b0e14", foreground: "#c5c8c6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    loadCanvasRenderer(term);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let lastCols = term.cols;
    let lastRows = term.rows;

    const input = term.onData((data) => {
      writePane(paneId, data);
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
      if (text) writeText(text).catch(() => {});
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
      if (send) writePane(paneId, send);
      if (block) {
        e.preventDefault();
        return false; // handled — don't let xterm emit its default (CR)
      }
      return true;
    });

    // The macOS Edit-menu Copy fires a native `copy` event (no keydown), so
    // route it through the clipboard manager too — cancel WebKit's own write
    // and put the real selection on the pasteboard over the same native path.
    const onCopy = (ev: ClipboardEvent) => {
      if (!term.hasSelection()) return;
      ev.preventDefault();
      copySelection();
    };
    host.addEventListener("copy", onCopy);

    // Own terminal paste the same way: intercept the DOM `paste` event (⌘V and
    // the Edit menu both end here) before xterm's built-in listener, read the
    // pasteboard through the clipboard manager, and hand the text — or, for an
    // image-only clipboard, a temp-PNG path — to xterm (which applies
    // bracketed paste itself). Capture phase so it wins over xterm's textarea
    // listener.
    const onPaste = createPasteHandler(readText, readImageTempPath, (text) =>
      term.paste(text),
    );
    host.addEventListener("paste", onPaste, true);

    // OSC 52 ([F21]): a program inside the pane (tmux, vim, an agent TUI)
    // copying to the clipboard emits OSC 52, which xterm's core drops — route
    // its payload through the clipboard manager. Write-only: queries are
    // consumed but never answered (a pane must not read the clipboard).
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const text = osc52Text(data);
      if (text) writeText(text).catch(() => {});
      return true;
    });

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
      writePane(paneId, text);
    });

    // Auto-naming ([F11]): mirror the terminal title (OSC 0/1/2) up to the pane.
    const titleSub = term.onTitleChange((t) => onTitleRef.current?.(t));

    // Cmd+click a URL or file path in the output to open it ([F14]/[F10]);
    // plain click is left for text selection (a plain click ON a link shows the
    // ⌘ hint, [U8]). Relative paths resolve against the pane's cwd; the OS
    // default app opens files / the default browser opens URLs. Detection runs
    // on the whole LOGICAL line — the requested row joined with its wrapped
    // neighbours — so a link the terminal wrapped is still one link, not
    // per-row fragments.
    const links = term.registerLinkProvider({
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
                  // Pane-local coords captured now, at click-time geometry,
                  // not when a rejection lands later.
                  const rect = host.getBoundingClientRect();
                  const at = {
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  };
                  // The ⌘ affordance is undiscoverable — answer a plain (or
                  // wrong-modifier) click on a link with how to open it ([U8]).
                  if (!event.metaKey) {
                    showHint({ text: "⌘-click to open", ...at });
                    return;
                  }
                  const target =
                    d.kind === "url"
                      ? d.text
                      : resolvePathTarget(d.text, cwd ?? "");
                  const open =
                    d.kind === "url" ? openUrl(target) : openPath(target);
                  // Surface the failure — a deleted file, a bad URL — next to
                  // the link that was clicked instead of swallowing it ([F16]).
                  open.catch((err: unknown) =>
                    showHint({ text: openErrorHint(err, target), ...at }),
                  );
                },
              })),
        );
      },
    });

    acquirePane(paneId, {
      command,
      args: argsRef.current,
      env: envRef.current,
      cwd,
      cols: term.cols,
      rows: term.rows,
    });
    const detach = attachPane(paneId, {
      onOutput: (bytes) => term.write(bytes),
      onExit: (code) => {
        const suffix = code !== null ? ` (${code})` : "";
        term.writeln(`\r\n\x1b[90m[process exited${suffix}]\x1b[0m`);
        onExitRef.current?.(code);
      },
      onSpawnError: (message) => {
        term.writeln(`\r\n\x1b[31m[failed to start session: ${message}]\x1b[0m`);
      },
      onReady: () => {
        // Sync the PTY to the current grid. A ResizeObserver can fire while the
        // spawn is pending (sibling panes mounting) — it advances the
        // lastCols/lastRows watermark but its resize is a no-op (no session
        // yet), leaving the PTY stuck at the spawn size while xterm grew. That
        // desync is what leaves blank rows + a phantom scroll (and garbles TUI
        // repaints). Resize unconditionally now to converge.
        lastCols = term.cols;
        lastRows = term.rows;
        resizePane(paneId, term.cols, term.rows);
      },
    });

    // Refit through the pump: xterm tracks the drag (one fit per frame), but
    // the PTY hears about it only once the size settles — otherwise every
    // observer tick SIGWINCHes the TUI, whose stale-width erase sequences
    // land on re-wrapped rows and shred the scrollback (see refitPump.ts).
    const pump = createRefitPump({
      fit: () => {
        // A grid re-tile can pass through a 0-sized layout; fitting then
        // would clamp the pane to 2x1 and rewrap the whole scrollback.
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        const buf = term.buffer.active;
        const atBottom = buf.viewportY === buf.baseY;
        fit.fit();
        // Reflow can leave the viewport mid-history; keep a bottom-pinned
        // pane pinned. A pane scrolled up is left where the user put it.
        if (atBottom) term.scrollToBottom();
      },
      // Only when the cell grid actually changed — a redundant SIGWINCH
      // makes the shell reprint its prompt.
      syncPty: () => {
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          resizePane(paneId, term.cols, term.rows);
        }
      },
    });
    const requestRefit = () => pump.request();
    const observer = new ResizeObserver(requestRefit);
    observer.observe(host);
    window.addEventListener("resize", requestRefit);

    return () => {
      window.removeEventListener("resize", requestRefit);
      pump.dispose();
      observer.disconnect();
      input.dispose();
      unregister();
      links.dispose();
      titleSub.dispose();
      selectionSub.dispose();
      osc52.dispose();
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste, true);
      ta?.removeEventListener("keydown", blockShiftEnterDefault, true);
      // Detach only — the session lives on in the manager. Closing a pane is
      // a deck action (useCloseFlow → closePane), never a render artifact.
      detach();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [command, cwd, paneId, showHint]);

  // Scrollback is a runtime xterm option — apply a settings change to the
  // live terminal ([F6]); shrinking trims the buffer, growing keeps it.
  useEffect(() => {
    const term = termRef.current;
    if (term && term.options.scrollback !== scrollback) {
      term.options.scrollback = scrollback;
    }
  }, [scrollback]);

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

  // xterm owns every DOM node inside the host div, so the hint is a SIBLING of
  // the host (React must not reconcile children xterm appended).
  return (
    <div className="terminal-pane">
      <div className="terminal-pane__host" ref={hostRef} />
      {hint && (
        <div className="terminal-pane__hint" role="status" ref={hintRef}>
          {hint.text}
        </div>
      )}
    </div>
  );
}

/** How long an in-pane hint stays up before it fades ([F16]). */
const HINT_MS = 2000;

/** A hint message anchored at the pane-local point that was clicked. */
interface PaneHint {
  text: string;
  x: number;
  y: number;
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
