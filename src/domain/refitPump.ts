/**
 * Tame terminal resize storms. Dragging the window edge (or re-tiling the
 * pane grid) fires ResizeObserver every frame; refitting xterm AND notifying
 * the PTY on every tick makes each running TUI redraw dozens of times, and
 * its erase sequences — computed for the previous width — land on re-wrapped
 * rows, pushing garbage frames into the scrollback.
 *
 * The pump splits the two halves of a refit:
 *  - `fit` (resize xterm to the host) is coalesced to at most once per
 *    animation frame, so the pane still tracks the drag visually;
 *  - `syncPty` (SIGWINCH to the agent) waits until the size has SETTLED —
 *    no fit for `settleMs` — so one gesture costs the TUI one redraw.
 *
 * Schedulers are injectable for tests; defaults are the real rAF/timeout.
 */

export interface RefitPump {
  /** Signal that the host may have resized. Safe to call in bursts. */
  request(): void;
  /** Cancel anything pending; further requests are no-ops. */
  dispose(): void;
}

export interface RefitPumpOptions {
  /** Resize xterm to the host now (may be a no-op if nothing changed). */
  fit(): void;
  /** Tell the PTY the current grid, if it differs from what it last saw. */
  syncPty(): void;
  /** Quiet time after the last fit before the PTY hears about it. */
  settleMs?: number;
  raf?: (cb: () => void) => number;
  cancelRaf?: (handle: number) => void;
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export const DEFAULT_SETTLE_MS = 175;

export function createRefitPump(options: RefitPumpOptions): RefitPump {
  const {
    fit,
    syncPty,
    settleMs = DEFAULT_SETTLE_MS,
    raf = (cb) => requestAnimationFrame(cb),
    cancelRaf = (h) => cancelAnimationFrame(h),
    setTimer = (cb, ms) => window.setTimeout(cb, ms),
    clearTimer = (h) => window.clearTimeout(h),
  } = options;

  let frame: number | null = null;
  let settle: number | null = null;
  let disposed = false;

  return {
    request() {
      if (disposed || frame !== null) return;
      frame = raf(() => {
        frame = null;
        fit();
        // Trailing edge: every fit pushes the PTY notification further out,
        // so a drag produces exactly one SIGWINCH, after it ends.
        if (settle !== null) clearTimer(settle);
        settle = setTimer(() => {
          settle = null;
          syncPty();
        }, settleMs);
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelRaf(frame);
      if (settle !== null) clearTimer(settle);
      frame = null;
      settle = null;
    },
  };
}
