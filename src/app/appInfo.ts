/**
 * The app's own identity — name, version, whether this build carries the
 * updater — read from the shell ONCE per process.
 *
 * Three readers fetched it each for themselves: the composition root for the
 * version in the bar, the updates section for the version in its row, and the
 * update manager for the updater probe. One fact, three round trips, and
 * three copies of the failure handling. The read is memoized here, and a
 * failed read is not kept: a reader asking after the shell comes up gets a
 * fresh attempt rather than a cached rejection.
 */
import { fetchAppInfo, type AppInfo } from "../ipc/app";

let pending: Promise<AppInfo> | null = null;

export function readAppInfo(): Promise<AppInfo> {
  pending ??= fetchAppInfo().catch((e: unknown) => {
    pending = null;
    throw e;
  });
  return pending;
}

/** Forget the cached read — for tests that double the shell per case. */
export function resetAppInfo(): void {
  pending = null;
}
