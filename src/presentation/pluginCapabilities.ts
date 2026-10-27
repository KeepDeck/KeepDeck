import type {
  Capability,
  CredentialDirectory,
  CredentialSource,
  NetDomain,
  RpcServerDeclaration,
} from "@keepdeck/plugin-api";
import type { ResolvedNet, ResolvedPermissions } from "../plugins/capabilities/permissions";

/**
 * What a plugin's declared capabilities let it do, in plain words — the
 * line an external plugin's enable switch shows, since enabling it IS the
 * consent. Every field that widens what a plugin may do is named verbatim:
 * a server it keeps running and each method it may call, each environment
 * variable it reads, and where a variable sends it — the rule as declared
 * and what it resolved to on this machine. A variable's raw value is never
 * shown: only the scope it chose.
 */
export function capabilitiesInWords(
  capabilities: readonly Capability[],
  permissions: ResolvedPermissions,
): string {
  let netIndex = 0;
  return capabilities
    .map((cap) => (cap.kind === "net" ? netInWords(cap, permissions.net[netIndex++]) : capabilityInWords(cap)))
    .join(", ");
}

type NetCapability = Extract<Capability, { kind: "net" }>;

function netInWords(cap: NetCapability, resolved: ResolvedNet | undefined): string {
  const reach = cap.domains.map((domain, index) => domainInWords(domain, resolved?.allow[index]));
  const signing = (cap.credentials ?? []).map((source) =>
    credentialInWords(source, resolved?.credentials.find((entry) => entry.id === source.id)?.dir),
  );
  return [`reach ${reach.join("/")}`, ...signing].join(" · ");
}

function domainInWords(domain: NetDomain, resolved: string | undefined): string {
  if (typeof domain === "string") return domain;
  return `${resolved ?? "?"} (${domain.env}, else ${domain.default})`;
}

function directoryRule(dir: CredentialDirectory): string {
  if (typeof dir === "string") return dir;
  return `${dir.env}, else ${dir.default}${dir.append ? `, then ${dir.append}` : ""}`;
}

function credentialInWords(source: CredentialSource, dir: string | undefined): string {
  return `sign requests with tokens from ${dir ?? "?"} (${directoryRule(source.dir)}; fields ${source.tokenFields.join(", ")})`;
}

function capabilityInWords(cap: Exclude<Capability, NetCapability>): string {
  switch (cap.kind) {
    case "exec":
      return [`run ${cap.commands.join("/")}`, ...(cap.servers ?? []).map(serverInWords)].join(" · ");
    case "fs":
      return cap.scope === "everywhere" ? "read any file" : "read project files";
    case "fsWrite":
      return `write inside ${cap.paths.join(", ")}`;
    case "sqliteReadonly":
      return `query databases (read-only) inside ${cap.paths.join(", ")}`;
    case "git":
      return cap.scope === "everywhere"
        ? "read git state of any repository"
        : "read git state of project repositories";
    case "env":
      return `read environment ${cap.names.join(", ")}`;
    case "legacyDownloads":
      return `adopt legacy downloads (${cap.migrations.map((migration) => migration.source).join(", ")})`;
    case "ports":
      return "allocate ports";
    case "open":
      return "open links & files";
    case "commands":
      return `drive the deck (${cap.execute.join(", ")})`;
    case "mic":
      return "use the microphone (local speech-to-text)";
    case "notifications":
      return "send notifications";
    case "clipboardWrite":
      return "copy text to the clipboard";
    case "clipboardRead":
      return "read the clipboard (sensitive — it can hold secrets)";
  }
}

function serverInWords(server: RpcServerDeclaration): string {
  const line = [server.command, ...server.args].join(" ");
  return `keep ${line} running, calls: ${server.methods.join(", ")}`;
}
