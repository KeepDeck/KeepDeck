import { fetchAppInfo } from "../ipc/app";
import { describeError, log } from "../ipc/log";
import { checkForUpdate, relaunchApp, type Update } from "../ipc/updater";

/**
 * The owner of the in-app update flow — one per app, outside React, like
 * `settingsManager`. Boot calls [`initUpdates`] once (main.tsx); React reads
 * through the `useUpdate` hook; the top-bar button and the Updates settings
 * section act through [`checkForUpdatesNow`]/[`restartToUpdate`].
 *
 * The flow is deliberately download-then-wait: an update found by the
 * periodic check downloads and verifies in the background, then sits in
 * `ready` until the USER restarts — the running deck is never yanked away.
 * Dev builds carry no updater config (see tauri.release.conf.json), the
 * `app_info` command reports that, and the whole flow stays `disabled`.
 */

export type UpdatePhase =
  | "disabled" // dev build — the updater plugin is not configured
  | "idle" // no update known; periodic checks continue
  | "checking"
  | "downloading"
  | "ready" // downloaded and signature-verified; waiting for the user
  | "installing"; // swapping the bundle and relaunching

export interface UpdateState {
  phase: UpdatePhase;
  /** The update's version, from `downloading` onward. */
  version: string | null;
  /** Download progress in bytes; `total` is null until the server says. */
  received: number;
  total: number | null;
  /** The last failure, kept for the settings row; cleared on a new check. */
  error: string | null;
  /** Epoch ms of the last completed check. */
  checkedAt: number | null;
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

function initial(): UpdateState {
  return {
    phase: "idle",
    version: null,
    received: 0,
    total: null,
    error: null,
    checkedAt: null,
  };
}

let state: UpdateState = initial();
/** The plugin's handle for the downloaded update — what `install()` applies. */
let update: Update | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let boot: Promise<void> | null = null;
const listeners = new Set<() => void>();

function apply(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

/**
 * Probe whether this build carries the updater at all, then start the
 * periodic check loop. Idempotent: repeated calls share the first boot.
 */
export function initUpdates(intervalMs = CHECK_INTERVAL_MS): Promise<void> {
  boot ??= fetchAppInfo()
    .then((info) => {
      if (!info.updater) {
        apply({ phase: "disabled" });
        return;
      }
      timer = setInterval(() => void runCheck(), intervalMs);
      return runCheck();
    })
    .catch((e) => {
      // No app_info means no bridge at all — treat as a build without updates.
      log.warn("web:update", `updater probe failed: ${describeError(e)}`);
      apply({ phase: "disabled" });
    });
  return boot;
}

/** Manual "Check for updates" from settings. A no-op while anything is in
 * flight or already waiting — restarting is the only move from `ready`. */
export function checkForUpdatesNow(): void {
  if (state.phase !== "idle") return;
  void runCheck();
}

async function runCheck(): Promise<void> {
  // A periodic tick may land while a download runs or an update waits in
  // `ready` — nothing useful to do until the user restarts.
  if (state.phase !== "idle") return;
  apply({ phase: "checking", error: null });
  try {
    const found = await checkForUpdate();
    if (!found) {
      apply({ phase: "idle", checkedAt: Date.now() });
      return;
    }
    apply({
      phase: "downloading",
      version: found.version,
      received: 0,
      total: null,
      checkedAt: Date.now(),
    });
    // Download (and signature-verify) now; install waits for the user.
    await found.download((event) => {
      if (event.event === "Started") {
        apply({ total: event.data.contentLength ?? null });
      } else if (event.event === "Progress") {
        apply({ received: state.received + event.data.chunkLength });
      }
    });
    update = found;
    apply({ phase: "ready" });
  } catch (e) {
    // Transient by assumption (offline, mid-publish signature mismatch…):
    // surface in settings, retry on the next tick.
    update = null;
    log.warn("web:update", `update check failed: ${describeError(e)}`);
    apply({ phase: "idle", error: describeError(e), checkedAt: Date.now() });
  }
}

/** Swap the downloaded bundle into place and relaunch. Only meaningful from
 * `ready`; deck and sessions survive through workspace persistence. */
export async function restartToUpdate(): Promise<void> {
  const pending = update;
  if (state.phase !== "ready" || !pending) return;
  apply({ phase: "installing" });
  try {
    await pending.install();
    await relaunchApp();
  } catch (e) {
    // The downloaded update is still intact — offer the restart again.
    log.error("web:update", `update install failed: ${describeError(e)}`);
    apply({ phase: "ready", error: describeError(e) });
  }
}

/** The live update state (stable between changes — the `useSyncExternalStore`
 * snapshot contract). */
export function getUpdateState(): UpdateState {
  return state;
}

/** Notify on every update-state change (the `useSyncExternalStore` contract). */
export function subscribeUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget the state, the boot, the timer and every listener. */
export function resetUpdateManager(): void {
  state = initial();
  update = null;
  if (timer) clearInterval(timer);
  timer = null;
  boot = null;
  listeners.clear();
}
