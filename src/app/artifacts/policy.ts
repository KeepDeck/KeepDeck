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
import { artifactsDisable, artifactsEnable } from "../../ipc/artifacts";

export interface ArtifactsSettingsPort {
  /** The toggle's value, or `null` until the settings load settles. */
  artifacts(): boolean | null;
  subscribe(listener: () => void): () => void;
}

export interface ArtifactsTransition {
  desired: boolean;
  ok: boolean;
  detail: string | null;
}

export interface ArtifactsPolicy {
  /** Stop reconciling. `disable: true` queues a FINAL disable onto the
   * same chain — an in-flight enable settles first, so a disposed page
   * can never leave the store claimed with nobody answering. */
  dispose(options?: { disable?: boolean }): void;
}

export function createArtifactsPolicy(
  settings: ArtifactsSettingsPort,
  report: (transition: ArtifactsTransition) => void,
): ArtifactsPolicy {
  let applied: boolean | null = null;
  let epoch = 0;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const reconcile = () => {
    if (disposed) return;
    const desired = settings.artifacts();
    if (desired === null || desired === applied) return;
    applied = desired;
    const call = ++epoch;
    chain = chain.then(async () => {
      try {
        const value = await (desired
          ? artifactsEnable()
          : artifactsDisable());
        report({
          desired,
          ok: true,
          detail: desired ? `display server on port ${value}` : null,
        });
      } catch (e) {
        const detail = describeError(e);
        log.warn(
          "web:artifacts",
          `artifacts ${desired ? "enable" : "disable"} failed: ${detail}`,
        );
        report({ desired, ok: false, detail });
        if (epoch === call) applied = null;
      }
    });
  };

  const unsubscribe = settings.subscribe(reconcile);
  reconcile();

  return {
    dispose(options = {}) {
      disposed = true;
      unsubscribe();
      if (options.disable) {
        chain = chain.then(async () => {
          try {
            await artifactsDisable();
          } catch (e) {
            log.warn(
              "web:artifacts",
              `final disable failed: ${describeError(e)}`,
            );
          }
        });
      }
    },
  };
}
