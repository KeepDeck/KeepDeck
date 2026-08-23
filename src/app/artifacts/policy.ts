/**
 * Reconcile the durable `artifacts` setting with the Rust store + display
 * server — the `createMcpServerPolicy` shape applied to the artifacts
 * feature: boot reconcile desired-vs-applied, enable/disable on every
 * toggle flip, serialized backend calls (a fast On→Off flip arrives as
 * enable-then-disable, never interleaved), and a failed call clearing the
 * applied mark ONLY when it was the latest (the epoch guard) so the next
 * settings event retries.
 *
 * Slice 3 wires this to the store-only enable pair; slice 5's server
 * attaches inside the same Rust `artifacts_enable` — the TS policy never
 * learns there are two halves.
 */
import { describeError, log } from "../../ipc/log";

export interface ArtifactsSettingsPort {
  /** The toggle's value, or `null` until the settings load settles. */
  artifacts(): boolean | null;
  subscribe(listener: () => void): () => void;
}

/** The backend calls the policy drives — injectable for tests, the
 * McpTransportPort pattern (the mcp policy's own comment applies verbatim:
 * the wiring site is the one owner of the transport binding). */
export interface ArtifactsTransportPort {
  enable(): Promise<unknown>;
  disable(): Promise<unknown>;
}

export interface ArtifactsTransition {
  desired: boolean;
  ok: boolean;
  detail: string | null;
}

export interface ArtifactsPolicy {
  /** Stop reconciling — and NOTHING else. It deliberately does not
   * disable the backend: the display server's life follows the SETTING
   * and the process, never the page. `beforeunload` fires on every window
   * reload (every HMR reload in dev), so a final disable here tore down a
   * live server, said goodbye to every open tab, and killed every url it
   * had handed out — on a process that never went anywhere. A real exit
   * needs no help: the store claim is an flock, released by the kernel.
   * (The mcp policy keeps its final disable — its socket is a NAME on
   * disk, which process death does leave behind.)
   * The report callback is ignored after `dispose()`, so a late
   * settlement cannot touch the torn-down runtime. */
  dispose(): void;
}

/**
 * Reconcile the durable `artifacts` setting with the Rust store + display
 * server — the `createMcpServerPolicy` shape applied to the artifacts
 * feature: boot reconcile desired-vs-applied, enable/disable on every
 * toggle flip, serialized backend calls, epoch-guarded retry. Dispose
 * stops reconciling and does NOT disable — see `ArtifactsPolicy.dispose`.
 * The transport port is REQUIRED (the mcp policy's own rule: the wiring
 * site is the one owner of the ipc binding). The report callback is
 * ignored after `dispose()`, so a late settlement cannot touch the
 * torn-down runtime.
 */
export function createArtifactsPolicy(
  settings: ArtifactsSettingsPort,
  // REQUIRED, not defaulted — a default would be a second home for the
  // transport binding (the mcp policy's comment, applied verbatim).
  transport: ArtifactsTransportPort,
  report: (transition: ArtifactsTransition) => void,
): ArtifactsPolicy {
  let applied: boolean | null = null;
  let epoch = 0;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (transition: ArtifactsTransition) => {
    // A notifier can settle a backend call after dispose; a torn-down runtime
    // must not re-register commands or invalidate a dead surface from that
    // late report.
    if (disposed) return;
    report(transition);
  };

  const reconcile = () => {
    // Unsubscribing is not enough: a notifier iterating a snapshot of its
    // listeners can still call this callback after dispose.
    if (disposed) return;
    const desired = settings.artifacts();
    if (desired === null || desired === applied) return;
    applied = desired;
    const call = ++epoch;
    chain = chain.then(async () => {
      try {
        const value = await (desired
          ? transport.enable()
          : transport.disable());
        deliver({
          desired,
          ok: true,
          // The port clause only when a REAL port came back — the honest
          // 0 (server arrives in slice 5) reports no lie.
          detail:
            desired && typeof value === "number" && value > 0
              ? `display server on port ${value}`
              : null,
        });
      } catch (e) {
        const detail = describeError(e);
        log.warn(
          "web:artifacts",
          `artifacts ${desired ? "enable" : "disable"} failed: ${detail}`,
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
