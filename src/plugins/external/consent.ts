import type { Capability, PluginManifest } from "@keepdeck/plugin-api";

/**
 * A stable fingerprint of a manifest's declared capabilities — what a user's
 * consent is RECORDED against (settings `plugins.consented[id]`). Enabling an
 * external plugin stores this string; on the next load its current capability
 * fingerprint is compared to the stored one, and a mismatch (an update that
 * asks for MORE) drops the plugin back to disabled until the user consents
 * again. So the fingerprint must be canonical: the same capability set always
 * produces the same string regardless of declaration order.
 */
export function capabilityFingerprint(manifest: PluginManifest): string {
  return JSON.stringify(manifest.capabilities.map(canonical).sort());
}

/** One capability as a canonical, order-independent string. */
function canonical(cap: Capability): string {
  switch (cap.kind) {
    case "exec":
      return `exec:${[...cap.commands].sort().join(",")}`;
    case "fs":
      return `fs:${cap.scope}`;
    case "net":
      return `net:${[...cap.domains].sort().join(",")}`;
    case "ports":
      return "ports";
    case "open":
      return "open";
  }
}
