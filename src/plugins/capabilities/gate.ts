import type {
  Capability,
  PluginLogger,
  PluginManifest,
  PluginServices,
} from "@keepdeck/plugin-api";
import { execCovers } from "./execCovers";

/**
 * CapabilityGate v0 — decorates an ungated `PluginServices` backend so every
 * call is checked against the manifest's declared capabilities before it
 * reaches the backend. This is the "granter at the call site" half of the
 * Zed model described on `Capability` (plugin-api): the manifest declares,
 * install-time consent approves the declaration, and this gate is what
 * actually stops an undeclared call at runtime — without it, capabilities
 * would be a label nobody enforces.
 *
 * v0 runs only built-in, trusted plugins, so `"warn"` mode exists to turn
 * every future contract violation into a visible tripwire in the log
 * WITHOUT taking the app down — a built-in plugin that outgrows its
 * manifest is a bug to fix, not a reason to crash a user's session. The
 * external plugin tier (untrusted, arbitrary code) will construct this gate
 * with `"enforce"` instead, where the identical violation throws.
 *
 * The gate is pure decoration: it holds no state beyond `manifest`/`backend`
 * and forwards an allowed call verbatim — same arguments, same return value,
 * no re-wrapping of the session handle — so a caller cannot tell a `"warn"`
 * pass-through from a call that was never gated at all.
 *
 * `fs` and `net` capabilities have no service to gate here: `PluginServices`
 * carries no `fs`/`net` member (v0 is `sessions` + `ports` only). `fs` is
 * validated by the manifest reader today and will be enforced wherever file
 * access actually lands; `net` is enforced later via the plugin realm's CSP.
 * Do not invent stand-in branches for either — an unused enforcement path
 * would claim a guarantee this module doesn't provide.
 */
export type GateMode = "warn" | "enforce";

export function createCapabilityGate(
  manifest: PluginManifest,
  backend: PluginServices,
  opts: { mode: GateMode; log: PluginLogger },
): PluginServices {
  const { mode, log } = opts;

  /** The single branch point between the two modes, so a violation can
   * never carry two different messages down two paths: `"warn"` logs and
   * returns (the call proceeds below); `"enforce"` throws here, before the
   * backend is ever reached. */
  function admit(ok: boolean, message: string): void {
    if (ok) return;
    if (mode === "enforce") throw new Error(message);
    log.warn(message);
  }

  return {
    sessions: {
      spawn(spawnOpts, onEvent) {
        // No command means the user's shell; a manifest that wants to spawn
        // it declares the literal entry "$SHELL" (see `PluginSpawnOptions`).
        const subject = spawnOpts.command ?? "$SHELL";
        admit(
          execCovers(manifest.capabilities, subject),
          `sessions.spawn: "${subject}" requires an "exec" capability covering it, which the manifest does not declare`,
        );
        return backend.sessions.spawn(spawnOpts, onEvent);
      },
    },
    ports: {
      allocate(key) {
        admit(
          hasPortsCapability(manifest.capabilities),
          `ports.allocate: "${key}" requires a "ports" capability, which the manifest does not declare`,
        );
        return backend.ports.allocate(key);
      },
    },
  };
}

function hasPortsCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "ports");
}
