import type { Capability, RpcServerDeclaration } from "@keepdeck/plugin-api";

/**
 * What a plugin's declared capabilities let it do, in plain words — the
 * line an external plugin's enable switch shows, since enabling it IS the
 * consent. Every field that widens what a plugin may do is named verbatim:
 * a server it keeps running and each method it may call.
 */
export function capabilitiesInWords(capabilities: readonly Capability[]): string {
  return capabilities.map(capabilityInWords).join(", ");
}

function capabilityInWords(cap: Capability): string {
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
    case "net":
      return `reach ${cap.domains.join("/")}`;
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
