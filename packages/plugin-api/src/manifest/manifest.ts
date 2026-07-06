import { CAPABILITY_KINDS, type Capability } from "./capabilities.ts";
import { parseVersion } from "./version.ts";

/**
 * The plugin manifest — the static half of a plugin, read BEFORE any of its
 * code runs. It carries identity, the API floor, the capability declaration,
 * and a summary of contributions so the host can show surfaces (and decide
 * activation) without loading the bundle. Unlike the deck's tolerant
 * persistence reads, manifest validation is STRICT and fails closed: a
 * plugin with a malformed manifest does not load, and the errors say why —
 * the manifest is a contract with a third party, not our own recoverable
 * data.
 */
export interface PluginManifest {
  /** Stable identity: lowercase segments separated by dots or hyphens
   * (e.g. `keepdeck.run`, `dev.example-preview`). Namespaces storage,
   * settings, and every contribution. */
  id: string;
  /** Human name shown in Experiments and consent UI. */
  name: string;
  /** The plugin's own semver — display and update bookkeeping only. */
  version: string;
  /** Minimum plugin-API version this plugin needs (see `API_VERSION`). */
  minApiVersion: string;
  description?: string;
  /** Platform access the plugin may use; empty = pure UI. */
  capabilities: Capability[];
  /** Static contribution summary — what the plugin will register when
   * activated. Lets the host render tab strips and pick lazy-activation
   * moments without executing plugin code. Every list entry is the same
   * `{id, label}` shape: `label` is what a user sees in lists and consent —
   * runtime contributions carry their own richer fields. */
  contributes: {
    dockTabs?: ContributionSummary[];
    topBarActions?: ContributionSummary[];
    paneActions?: ContributionSummary[];
    agents?: ContributionSummary[];
    /** The plugin registers a host-rendered settings section. */
    settings?: boolean;
  };
}

/** One statically-declared contribution: identity plus a display name. */
export interface ContributionSummary {
  id: string;
  label: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/**
 * Validate an untrusted manifest value. Collects EVERY problem instead of
 * stopping at the first — a plugin author fixes the whole list in one round.
 */
export function readManifest(value: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }

  const id = typeof value.id === "string" ? value.id : null;
  if (!id) errors.push("id: required string");
  else if (!ID_PATTERN.test(id))
    errors.push(
      `id: "${id}" must be lowercase segments separated by "." or "-"`,
    );

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) errors.push("name: required non-empty string");

  const version = typeof value.version === "string" ? value.version : "";
  if (!parseVersion(version))
    errors.push(`version: "${version}" is not major.minor.patch`);

  const minApiVersion =
    typeof value.minApiVersion === "string" ? value.minApiVersion : "";
  if (!parseVersion(minApiVersion))
    errors.push(`minApiVersion: "${minApiVersion}" is not major.minor.patch`);

  const capabilities = readCapabilities(value.capabilities, errors);
  const contributes = readContributes(value.contributes, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      id: id!,
      name,
      version,
      minApiVersion,
      ...(typeof value.description === "string" && value.description.trim()
        ? { description: value.description.trim() }
        : {}),
      capabilities,
      contributes,
    },
  };
}

/** Strict, fail-closed: an unknown capability kind is an error (see
 * `capabilities.ts`), and each kind's payload must be exactly right. */
function readCapabilities(value: unknown, errors: string[]): Capability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("capabilities: must be an array");
    return [];
  }
  const out: Capability[] = [];
  value.forEach((cap, i) => {
    const at = `capabilities[${i}]`;
    if (!isRecord(cap) || typeof cap.kind !== "string") {
      errors.push(`${at}: must be an object with a "kind"`);
      return;
    }
    switch (cap.kind) {
      case "exec":
        if (!isStringArray(cap.commands) || cap.commands.length === 0)
          errors.push(`${at}: exec needs a non-empty "commands" string array`);
        else out.push({ kind: "exec", commands: cap.commands });
        return;
      case "fs":
        if (cap.scope !== "workspace" && cap.scope !== "everywhere")
          errors.push(`${at}: fs "scope" must be "workspace" or "everywhere"`);
        else out.push({ kind: "fs", scope: cap.scope });
        return;
      case "net":
        if (!isStringArray(cap.domains) || cap.domains.length === 0)
          errors.push(`${at}: net needs a non-empty "domains" string array`);
        else if (cap.domains.some((d) => d.includes("*")))
          errors.push(`${at}: net domains must be literal hosts, no wildcards`);
        else out.push({ kind: "net", domains: cap.domains });
        return;
      case "ports":
        out.push({ kind: "ports" });
        return;
      case "open":
        out.push({ kind: "open" });
        return;
      default:
        errors.push(
          `${at}: unknown kind "${cap.kind}" (known: ${CAPABILITY_KINDS.join(", ")})`,
        );
    }
  });
  return out;
}

function readContributes(
  value: unknown,
  errors: string[],
): PluginManifest["contributes"] {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push("contributes: must be an object");
    return {};
  }
  const out: PluginManifest["contributes"] = {};
  const dockTabs = readSummaries(value.dockTabs, "dockTabs", errors);
  if (dockTabs) out.dockTabs = dockTabs;
  const topBarActions = readSummaries(
    value.topBarActions,
    "topBarActions",
    errors,
  );
  if (topBarActions) out.topBarActions = topBarActions;
  const paneActions = readSummaries(value.paneActions, "paneActions", errors);
  if (paneActions) out.paneActions = paneActions;
  const agents = readSummaries(value.agents, "agents", errors);
  if (agents) out.agents = agents;
  if (value.settings !== undefined) {
    if (typeof value.settings !== "boolean")
      errors.push("contributes.settings: must be a boolean");
    else out.settings = value.settings;
  }
  return out;
}

/** One summary list; `undefined` when absent, invalid, or empty (an entry
 * error is reported but never drops the whole list's valid siblings). */
function readSummaries(
  value: unknown,
  key: string,
  errors: string[],
): ContributionSummary[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`contributes.${key}: must be an array`);
    return undefined;
  }
  const read: ContributionSummary[] = [];
  value.forEach((entry, i) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      typeof entry.label !== "string" ||
      !entry.label.trim()
    ) {
      errors.push(`contributes.${key}[${i}]: needs string "id" and "label"`);
      return;
    }
    read.push({ id: entry.id, label: entry.label });
  });
  return read.length > 0 ? read : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
