import { isJsonRecord } from "@keepdeck/plugin-api";

/**
 * What a plugin's `env` and `net` declarations resolved to on this machine —
 * computed once, natively (`plugin_permissions.rs`), from the app's startup
 * environment, and read from here by the gate (env values), the consent
 * fingerprint and the consent words. The native side keeps the same result
 * by plugin id and holds http and downloads to it. Nothing re-resolves.
 */
export interface ResolvedPermissions {
  /** Every declared variable, with its raw value or null when unset. */
  env: Readonly<Record<string, string | null>>;
  /** One per `net` capability, in manifest order. */
  net: readonly ResolvedNet[];
}

export interface ResolvedNet {
  /** A literal `host[:port]` or an exact `scheme://host:port` origin. */
  allow: readonly string[];
  credentials: readonly ResolvedCredential[];
}

export interface ResolvedCredential {
  id: string;
  /** Absolute; the directory the token files are read from. */
  dir: string;
  tokenFields: readonly string[];
}

/** A plugin that declares neither `env` nor `net` resolves to nothing. */
export const NO_PERMISSIONS: ResolvedPermissions = { env: {}, net: [] };

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isResolvedCredential(value: unknown): value is ResolvedCredential {
  return isJsonRecord(value) && typeof value.id === "string" && typeof value.dir === "string" && isStrings(value.tokenFields);
}

function isResolvedNet(value: unknown): value is ResolvedNet {
  return (
    isJsonRecord(value) &&
    isStrings(value.allow) &&
    Array.isArray(value.credentials) &&
    value.credentials.every(isResolvedCredential)
  );
}

/** The native answer, checked before anything trusts it. */
export function isResolvedPermissions(value: unknown): value is ResolvedPermissions {
  return (
    isJsonRecord(value) &&
    isJsonRecord(value.env) &&
    Object.values(value.env).every((entry) => entry === null || typeof entry === "string") &&
    Array.isArray(value.net) &&
    value.net.every(isResolvedNet)
  );
}
