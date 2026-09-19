/**
 * Reconcile a durable ON/OFF setting with a backend that has to be told —
 * the one machine behind every switch of that kind (the MCP server's
 * shape, first applied to artifacts, now shared with the task board):
 *
 * - boot reconcile desired-vs-applied once the settings load settles;
 * - enable/disable on every flip, serialized (a fast On→Off arrives as
 *   enable-then-disable, never interleaved);
 * - a failed call clears the applied mark ONLY when it was the latest (the
 *   epoch guard), so the next settings event retries;
 * - dispose stops reconciling and does NOT disable — the backend's life
 *   follows the setting and the process, never the page (`beforeunload`
 *   fires on every dev reload).
 *
 * The transport is REQUIRED, not defaulted: the wiring site is the one
 * owner of the ipc binding, and a default here would be a second home for
 * it. The report callback is ignored after `dispose()`, so a late
 * settlement cannot touch a torn-down runtime.
 */
import { describeError, log, type LogTarget } from "../ipc/log";

export interface EnableSettingsPort {
  /** The toggle's value, or `null` until the settings load settles. */
  desired(): boolean | null;
  subscribe(listener: () => void): () => void;
}

export interface EnableTransportPort {
  enable(): Promise<unknown>;
  disable(): Promise<unknown>;
}

export interface EnableTransition {
  desired: boolean;
  ok: boolean;
  /** What the backend said — a port on success when the feature has one,
   * the refusal on failure, else null. */
  detail: string | null;
}

export interface EnablePolicy {
  dispose(): void;
}

export interface EnablePolicyOptions {
  /** Where this feature logs. */
  target: LogTarget;
  /** The word for the feature in a failure line ("artifacts", "tasks"). */
  feature: string;
  /** What a successful ENABLE's return value means, when it means
   * anything — the artifacts server's port clause. Absent = no detail. */
  successDetail?(value: unknown): string | null;
}

export function createEnablePolicy(
  settings: EnableSettingsPort,
  transport: EnableTransportPort,
  report: (transition: EnableTransition) => void,
  options: EnablePolicyOptions,
): EnablePolicy {
  let applied: boolean | null = null;
  let epoch = 0;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (transition: EnableTransition) => {
    // A notifier can settle a backend call after dispose; a torn-down
    // runtime must not re-register commands or invalidate a dead surface
    // from that late report.
    if (disposed) return;
    report(transition);
  };

  const reconcile = () => {
    // Unsubscribing is not enough: a notifier iterating a snapshot of its
    // listeners can still call this callback after dispose.
    if (disposed) return;
    const desired = settings.desired();
    if (desired === null || desired === applied) return;
    applied = desired;
    const call = ++epoch;
    chain = chain.then(async () => {
      try {
        const value = await (desired ? transport.enable() : transport.disable());
        deliver({
          desired,
          ok: true,
          detail: desired ? (options.successDetail?.(value) ?? null) : null,
        });
      } catch (e) {
        const detail = describeError(e);
        log.warn(
          options.target,
          `${options.feature} ${desired ? "enable" : "disable"} failed: ${detail}`,
        );
        deliver({ desired, ok: false, detail });
        if (epoch === call) applied = null;
      }
    });
  };

  const unsubscribe = settings.subscribe(reconcile);
  reconcile();

  return {
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
