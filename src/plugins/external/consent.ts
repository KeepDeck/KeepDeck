import type {
  Capability,
  JsonValue,
  PluginManifest,
  RpcServerDeclaration,
} from "@keepdeck/plugin-api";
import type { ResolvedNet, ResolvedPermissions } from "../capabilities/permissions";

/**
 * A stable fingerprint of a manifest's declared capabilities — what a user's
 * consent is RECORDED against (settings `plugins.consented[id]`). Enabling an
 * external plugin stores this string; on the next load its current capability
 * fingerprint is compared to the stored one, and a mismatch (an update that
 * asks for MORE) drops the plugin back to disabled until the user consents
 * again. So the fingerprint must be canonical: the same capability set always
 * produces the same string regardless of declaration order.
 *
 * The CATEGORY is part of the fingerprint too: a plugin flipping deck→cli
 * changes what it IS (it may now define an agent that runs a binary), and
 * that change must re-prompt even when the capability list happens to stay
 * identical.
 *
 * Where a declaration depends on the environment, what it RESOLVED to is
 * part of it too: the same manifest reaching a new origin or reading tokens
 * from a new directory asks again. Raw variable values never enter it —
 * only the names, and the scope derived from the values.
 */
export function capabilityFingerprint(
  manifest: PluginManifest,
  permissions: ResolvedPermissions,
): string {
  let netIndex = 0;
  return JSON.stringify([
    `category:${manifest.category}`,
    ...manifest.capabilities
      .map((cap) => (cap.kind === "net" ? canonicalNet(cap, permissions.net[netIndex++]) : canonical(cap)))
      .sort(),
  ]);
}

type NetCapability = Extract<Capability, { kind: "net" }>;

/** A `net` entry. Literal hosts alone keep the string they always had, so
 * the contract growing re-asks no one; a variable or a credential source
 * makes it a JSON tuple of the declaration and what it resolved to — sets
 * sorted, `tokenFields` kept in its order (it is a preference). */
function canonicalNet(cap: NetCapability, resolved: ResolvedNet | undefined): string {
  const literal = cap.domains.filter((domain): domain is string => typeof domain === "string");
  if (literal.length === cap.domains.length && !cap.credentials) return `net:${[...literal].sort().join(",")}`;
  const sorted = (items: unknown[]) => items.map((item) => JSON.stringify(item)).sort();
  return JSON.stringify([
    "net",
    sorted(cap.domains.map((domain) => (typeof domain === "string" ? ["host", domain] : ["urlEnv", domain.env, domain.default]))),
    sorted(
      (cap.credentials ?? []).map((source) => [
        source.id,
        typeof source.dir === "string"
          ? ["path", source.dir]
          : ["envPath", source.dir.env, source.dir.default, source.dir.append ?? ""],
        source.tokenFields,
      ]),
    ),
    [...(resolved?.allow ?? [])].sort(),
    sorted((resolved?.credentials ?? []).map((source) => [source.id, source.dir])),
  ]);
}

/** Declared servers as JSON tuples — every field consent shows, the method
 * set sorted, the servers ordered by id, the handshake's params with sorted
 * keys. A tuple, not a join, so no value can pose as a separator. */
function canonicalServers(servers: readonly RpcServerDeclaration[]): string {
  return JSON.stringify(
    [...servers]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((server) => [
        server.id,
        server.command,
        server.args,
        [...server.methods].sort(),
        server.handshake
          ? [server.handshake.method, sortedKeys(server.handshake.params ?? null), server.handshake.then ?? null]
          : null,
      ]),
  );
}

/** The same JSON whatever order its object keys were written in. */
function sortedKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

/** One capability as a canonical, order-independent string. */
function canonical(cap: Exclude<Capability, NetCapability>): string {
  switch (cap.kind) {
    case "exec": {
      const commands = `exec:${[...cap.commands].sort().join(",")}`;
      // Without servers the string stays what it always was, so adding the
      // field to the contract re-asks no one.
      return cap.servers ? `${commands}|servers:${canonicalServers(cap.servers)}` : commands;
    }
    case "fs":
      return `fs:${cap.scope}`;
    case "fsWrite":
      return `fsWrite:${[...cap.paths].sort().join(",")}`;
    case "sqliteReadonly":
      return `sqliteReadonly:${[...cap.paths].sort().join(",")}`;
    case "git":
      return `git:${cap.scope}`;
    case "env":
      return `env:${JSON.stringify([...new Set(cap.names)].sort())}`;
    case "legacyDownloads":
      return `legacyDownloads:${cap.migrations
        .map((migration) =>
          `${migration.source}>${migration.target}:${migration.stripSingleRoots === true}`,
        )
        .sort()
        .join(",")}`;
    case "ports":
      return "ports";
    case "open":
      return "open";
    case "commands":
      return `commands:${[...cap.execute].sort().join(",")}`;
    case "mic":
      return "mic";
    case "notifications":
      return "notifications";
    case "clipboardWrite":
      return "clipboardWrite";
    case "clipboardRead":
      return "clipboardRead";
  }
}
