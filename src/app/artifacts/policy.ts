/**
 * The artifacts feature's enable policy: the shared reconcile machine
 * ([`createEnablePolicy`]) bound to the `artifacts` setting, with the one
 * fact only this feature's enable returns — the display server's port.
 *
 * Slice 3 wired this to the store-only enable pair; slice 5's server
 * attaches inside the same Rust `artifacts_enable` — the policy never
 * learns there are two halves. Dispose stops reconciling and does NOT
 * disable: the display server's life follows the SETTING and the process,
 * never the page — a final disable here on `beforeunload` tore down a
 * live server on every dev reload. (The mcp policy keeps its final
 * disable — its socket is a NAME on disk, which process death does leave
 * behind.)
 */
import {
  createEnablePolicy,
  type EnablePolicy,
  type EnableTransition,
  type EnableTransportPort,
} from "../enablePolicy";

export interface ArtifactsSettingsPort {
  /** The toggle's value, or `null` until the settings load settles. */
  artifacts(): boolean | null;
  subscribe(listener: () => void): () => void;
}

export type ArtifactsTransportPort = EnableTransportPort;
export type ArtifactsTransition = EnableTransition;
export type ArtifactsPolicy = EnablePolicy;

export function createArtifactsPolicy(
  settings: ArtifactsSettingsPort,
  // REQUIRED, not defaulted — a default would be a second home for the
  // transport binding (the mcp policy's comment, applied verbatim).
  transport: ArtifactsTransportPort,
  report: (transition: ArtifactsTransition) => void,
): ArtifactsPolicy {
  return createEnablePolicy(
    { desired: settings.artifacts, subscribe: settings.subscribe },
    transport,
    report,
    {
      target: "web:artifacts",
      feature: "artifacts",
      // The port clause only when a REAL port came back — the honest 0
      // (server not yet attached) reports no lie.
      successDetail: (value) =>
        typeof value === "number" && value > 0 ? `display server on port ${value}` : null,
    },
  );
}
