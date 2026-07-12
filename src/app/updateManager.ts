import { fetchAppInfo } from "../ipc/app";
import { describeError, log } from "../ipc/log";
import { checkForUpdate, relaunchApp, type Update } from "../ipc/updater";

/**
 * The owner of the in-app update flow — one per app, outside React, like
 * `settingsManager`. Boot calls [`initUpdates`] once (main.tsx); React reads
 * through the `useUpdate` hook; the top bar and the Updates settings section
 * act through the exported actions.
 *
 * The flow is deliberately consent-driven — NOTHING is downloaded or
 * installed without an explicit user action (user decision 2026-07-12, after
 * the first cut auto-downloaded on a manual check):
 *
 *   check (boot / periodic / manual) → `available`   — found, zero bytes
 *   [Download]                       → `downloading` → `ready`
 *   [Restart to update]              → `installing`  → relaunch
 *   [Dismiss]                        → back to `idle` from available/ready
 *
 * Dev builds carry no updater config (see tauri.release.conf.json), the
 * `app_info` command reports that, and the whole flow stays `disabled`.
 */

export type UpdatePhase =
  | "disabled" // dev build — the updater plugin is not configured
  | "idle" // no update known; periodic checks continue
  | "checking"
  | "available" // a newer version exists; nothing has been downloaded
  | "downloading"
  | "ready" // downloaded and signature-verified; waiting for the user
  | "installing"; // swapping the bundle and relaunching

export interface UpdateState {
  phase: UpdatePhase;
  /** The update's version, from `available` onward. */
  version: string | null;
  /** Download progress in bytes; `total` is null until the server says. */
  received: number;
  total: number | null;
  /** The last failure, kept for the settings row; cleared on a new attempt. */
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
/** The plugin's handle for the found update — download() and install() live
 * on it, so it is kept from `available` through `installing`. */
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
 * flight or already found — those states have their own actions. */
export function checkForUpdatesNow(): void {
  if (state.phase !== "idle") return;
  void runCheck();
}

async function runCheck(): Promise<void> {
  // A periodic tick may land while a found update awaits a decision or a
  // download runs — the user's move, nothing to re-check.
  if (state.phase !== "idle") return;
  apply({ phase: "checking", error: null });
  try {
    const found = await checkForUpdate();
    if (!found) {
      apply({ phase: "idle", checkedAt: Date.now() });
      return;
    }
    // Found — and STOP. Zero bytes move until the user asks for them.
    update = found;
    apply({ phase: "available", version: found.version, checkedAt: Date.now() });
  } catch (e) {
    // Transient by assumption (offline, mid-publish window…): surface in
    // settings, retry on the next tick.
    update = null;
    log.warn("web:update", `update check failed: ${describeError(e)}`);
    apply({ phase: "idle", error: describeError(e), checkedAt: Date.now() });
  }
}

/** Explicit consent to fetch the found update. Downloads and verifies the
 * signature, then waits in `ready` — installing is a separate decision. */
export async function downloadUpdate(): Promise<void> {
  const pending = update;
  if (state.phase !== "available" || !pending) return;
  apply({ phase: "downloading", received: 0, total: null, error: null });
  try {
    await pending.download((event) => {
      if (event.event === "Started") {
        apply({ total: event.data.contentLength ?? null });
      } else if (event.event === "Progress") {
        apply({ received: state.received + event.data.chunkLength });
      }
    });
    apply({ phase: "ready" });
  } catch (e) {
    // The update is still known-available; the Download button retries.
    log.warn("web:update", `update download failed: ${describeError(e)}`);
    apply({ phase: "available", error: describeError(e) });
  }
}

/** Forget the found (or downloaded) update and return to `idle`. A later
 * check — periodic or manual — will offer it again. */
export function dismissUpdate(): void {
  if (state.phase !== "available" && state.phase !== "ready") return;
  update = null;
  apply({ phase: "idle", version: null, received: 0, total: null });
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
