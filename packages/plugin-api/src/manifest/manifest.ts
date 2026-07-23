import { CAPABILITY_KINDS, type Capability } from "./capabilities.ts";
import { hasUnsafeText } from "./text.ts";
import { isApiVersion, parseVersion } from "./version.ts";

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
  /** Minimum plugin-API REVISION this plugin needs — a plain integer floor
   * (see `API_VERSION`), not semver. */
  minApiVersion: number;
  /** What KIND of plugin this is (absent in the source manifest = `deck`).
   * The category scopes the contribution surface — validated here, enforced
   * again at registration — so a deck plugin can never sneak in an agent and
   * vice versa. */
  category: PluginCategory;
  description?: string;
  /** Marks the plugin as experimental — the host badges it in settings so a
   * user knows to expect rough edges. Absent = stable. */
  experimental?: boolean;
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
    /** File-open handlers: the plugin claims the host's "open this file"
     * gestures (terminal links), falling back to the system opener. */
    fileOpeners?: ContributionSummary[];
    /** Resident overlays: components the host keeps mounted while the
     * plugin is active, independent of dock/panel state. */
    overlays?: ContributionSummary[];
    agents?: AgentContributionSummary[];
    /** Commands the plugin registers in the command registry. Entry ids are
     * plain tokens; the registry id becomes `<pluginId>.<entryId>`. */
    commands?: ContributionSummary[];
    /** The plugin registers a host-rendered settings section. */
    settings?: boolean;
  };
}

/** One statically-declared contribution: identity plus a display name. */
export interface ContributionSummary {
  id: string;
  label: string;
}

/** An agent contribution additionally declares the program its agent needs
 * on PATH (`detect.bin` at registration — the host enforces the match). This
 * is what lets the host know a cli plugin's binary BEFORE any plugin code
 * runs, so availability (installed vs not) can gate activation centrally. */
export interface AgentContributionSummary extends ContributionSummary {
  bin?: string;
}

/** The binaries a plugin's declared agents need — the host's pre-activation
 * input to one shared detection pass and its activation gate. */
export function declaredAgentBins(manifest: PluginManifest): string[] {
  return (manifest.contributes.agents ?? [])
    .map((agent) => agent.bin)
    .filter((bin): bin is string => typeof bin === "string" && bin !== "");
}

/** Plugin categories. `cli` teaches KeepDeck a coding agent — it may
 * contribute `agents` (plus a settings section) and nothing visual; `deck`
 * extends the deck's own chrome (dock tabs, actions, settings) and may not
 * contribute agents. Grouping in the Plugins UI follows this field. */
export type PluginCategory = "cli" | "deck";

/** Contribution kinds a `cli` plugin may NOT declare (they're deck chrome). */
const DECK_ONLY_KINDS = [
  "dockTabs",
  "topBarActions",
  "paneActions",
  "fileOpeners",
  "overlays",
] as const;

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Name length cap — the name rides in front of notification titles, so it
 * shares their "a glance, not a document" budget. */
const NAME_MAX = 40;

/** A bare hostname (dotted labels, `localhost`, IPv4) with an optional port —
 * the only shape a `net` domain may take, since each is spliced into a CSP
 * header. Deliberately excludes schemes, paths, and any separator/whitespace. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

function safeRelativePath(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** A contribution id — a plain token safe as both a URL path component and a
 * registry key. No dots/slashes/whitespace. */
const CONTRIB_ID = /^[a-zA-Z0-9_-]+$/;

/** A `commands` execute pattern: a full dotted registry id, or a namespace
 * with a trailing `.*`. Mirrors the registry's own id grammar (lowercase
 * first character per segment, hyphens allowed) so a declared pattern can
 * actually match something. */
const COMMAND_PATTERN =
  /^[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$|^[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)*\.\*$/;

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

  // The name is a TRUST SIGNAL: the host prefixes it onto every notification
  // the plugin sends, and the plugin list shows it as the plugin's face. So
  // it must stay one short visible line (no control/bidi restructuring), stay
  // bounded (it is prepended AFTER other length caps), and must not claim to
  // be the app itself.
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) errors.push("name: required non-empty string");
  else if (name.length > NAME_MAX)
    errors.push(`name: longer than ${NAME_MAX} characters`);
  else if (hasUnsafeText(name))
    errors.push("name: control or bidi characters are not allowed");
  else if (name.toLowerCase() === "keepdeck")
    errors.push(`name: "${name}" impersonates the app`);

  const version = typeof value.version === "string" ? value.version : "";
  if (!parseVersion(version))
    errors.push(`version: "${version}" is not major.minor.patch`);

  const minApiVersion = isApiVersion(value.minApiVersion)
    ? value.minApiVersion
    : null;
  if (minApiVersion === null)
    errors.push(
      `minApiVersion: ${JSON.stringify(value.minApiVersion)} must be a non-negative integer`,
    );

  const capabilities = readCapabilities(value.capabilities, errors);
  const contributes = readContributes(value.contributes, errors);
  const category = readCategory(value.category, errors);

  // The category bounds the contribution surface — a manifest crossing the
  // line is invalid, not silently trimmed.
  if (category === "cli") {
    for (const kind of DECK_ONLY_KINDS) {
      if (contributes[kind])
        errors.push(`contributes.${kind}: a "cli" plugin contributes agents, not deck chrome`);
    }
  } else if (contributes.agents) {
    errors.push(`contributes.agents: requires category "cli"`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      id: id!,
      name,
      version,
      minApiVersion: minApiVersion!,
      category,
      ...(typeof value.description === "string" && value.description.trim()
        ? { description: value.description.trim() }
        : {}),
      ...(value.experimental === true ? { experimental: true } : {}),
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
      case "fsWrite":
        if (!isStringArray(cap.paths) || cap.paths.length === 0)
          errors.push(`${at}: fsWrite needs a non-empty "paths" string array`);
        else out.push({ kind: "fsWrite", paths: cap.paths });
        break;
      case "sqliteReadonly":
        if (!isStringArray(cap.paths) || cap.paths.length === 0)
          errors.push(`${at}: sqliteReadonly needs a non-empty "paths" string array`);
        else out.push({ kind: "sqliteReadonly", paths: cap.paths });
        break;
      case "git":
        if (cap.scope !== "workspace" && cap.scope !== "everywhere")
          errors.push(`${at}: git "scope" must be "workspace" or "everywhere"`);
        else out.push({ kind: "git", scope: cap.scope });
        return;
      case "net":
        if (!isStringArray(cap.domains) || cap.domains.length === 0)
          errors.push(`${at}: net needs a non-empty "domains" string array`);
        else if (cap.domains.some((d) => !HOSTNAME.test(d)))
          // Strict hostname grammar: the domains are interpolated into the
          // realm's CSP `connect-src` — a value carrying a space, `;`, or a
          // CR/LF would inject a directive or break the header outright, so a
          // non-hostname is a manifest ERROR, not a silently-passed string.
          errors.push(
            `${at}: net domains must be bare hostnames (optionally :port), no wildcards or separators`,
          );
        else out.push({ kind: "net", domains: cap.domains });
        return;
      case "legacyDownloads":
        if (!Array.isArray(cap.migrations) || cap.migrations.length === 0) {
          errors.push(`${at}: legacyDownloads needs non-empty "migrations"`);
        } else {
          const migrations = cap.migrations.flatMap((raw, index) => {
            const field = `${at}.migrations[${index}]`;
            if (!isRecord(raw)) {
              errors.push(`${field}: must be an object`);
              return [];
            }
            if (
              typeof raw.source !== "string" ||
              typeof raw.target !== "string" ||
              !safeRelativePath(raw.source) ||
              !safeRelativePath(raw.target)
            ) {
              errors.push(`${field}: source and target must be safe relative paths`);
              return [];
            }
            if (
              raw.stripSingleRoots !== undefined &&
              typeof raw.stripSingleRoots !== "boolean"
            ) {
              errors.push(`${field}: stripSingleRoots must be boolean`);
              return [];
            }
            return [{
              source: raw.source,
              target: raw.target,
              ...(raw.stripSingleRoots === true ? { stripSingleRoots: true } : {}),
            }];
          });
          if (migrations.length === cap.migrations.length) {
            out.push({ kind: "legacyDownloads", migrations });
          }
        }
        return;
      case "ports":
        out.push({ kind: "ports" });
        return;
      case "open":
        out.push({ kind: "open" });
        return;
      case "mic":
        out.push({ kind: "mic" });
        return;
      case "notifications":
        out.push({ kind: "notifications" });
        return;
      case "clipboardWrite":
        out.push({ kind: "clipboardWrite" });
        return;
      case "clipboardRead":
        out.push({ kind: "clipboardRead" });
        return;
      case "commands":
        if (!isStringArray(cap.execute) || cap.execute.length === 0)
          errors.push(`${at}: commands needs a non-empty "execute" string array`);
        else if (cap.execute.some((p) => !COMMAND_PATTERN.test(p)))
          errors.push(
            `${at}: commands execute patterns must be dotted ids like "agent.spawn" or namespace wildcards like "agent.*" (a bare "*" is not allowed)`,
          );
        else out.push({ kind: "commands", execute: cap.execute });
        return;
      default:
        errors.push(
          `${at}: unknown kind "${cap.kind}" (known: ${CAPABILITY_KINDS.join(", ")})`,
        );
    }
  });
  return out;
}

/** `category` is optional in the source manifest — absent means `deck`, the
 * common case — but always resolved in the parsed result. */
function readCategory(value: unknown, errors: string[]): PluginCategory {
  if (value === undefined) return "deck";
  if (value === "cli" || value === "deck") return value;
  errors.push(`category: ${JSON.stringify(value)} must be "cli" or "deck"`);
  return "deck";
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
  const fileOpeners = readSummaries(value.fileOpeners, "fileOpeners", errors);
  if (fileOpeners) out.fileOpeners = fileOpeners;
  const overlays = readSummaries(value.overlays, "overlays", errors);
  if (overlays) out.overlays = overlays;
  const agents = readAgentSummaries(value.agents, errors);
  if (agents) out.agents = agents;
  const commands = readSummaries(value.commands, "commands", errors);
  if (commands) out.commands = commands;
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
    const summary = readSummaryEntry(entry, key, i, errors);
    if (summary) read.push(summary);
  });
  return read.length > 0 ? read : undefined;
}

/** Validate one summary entry's base `{id, label}`; null (with the error
 * recorded) when invalid. The SINGLE source of the id rule — a contribution
 * id is used as a URL path component (an external dock tab's `<id>.html`
 * document) and as a registry key, so it must be a plain token; kind-specific
 * readers (agents add `bin`) build on this so the rule can never drift
 * between contribution kinds. */
function readSummaryEntry(
  entry: unknown,
  key: string,
  i: number,
  errors: string[],
): ContributionSummary | null {
  if (
    !isRecord(entry) ||
    typeof entry.id !== "string" ||
    !entry.id.trim() ||
    typeof entry.label !== "string" ||
    !entry.label.trim()
  ) {
    errors.push(`contributes.${key}[${i}]: needs string "id" and "label"`);
    return null;
  }
  if (!CONTRIB_ID.test(entry.id)) {
    errors.push(
      `contributes.${key}[${i}]: id "${entry.id}" must be alphanumerics, "-" or "_" only`,
    );
    return null;
  }
  return { id: entry.id, label: entry.label };
}

/** Agent summaries share the base {id, label} rules (readSummaryEntry) and
 * add the optional `bin` — when present it must be a non-empty plain program
 * name (it is resolved against PATH at detection time, so no paths or
 * whitespace). One pass over the raw entries: joining `bin` back by index
 * across a filtered intermediate would misalign fields the moment an invalid
 * sibling drops. */
function readAgentSummaries(
  value: unknown,
  errors: string[],
): AgentContributionSummary[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`contributes.agents: must be an array`);
    return undefined;
  }
  const read: AgentContributionSummary[] = [];
  value.forEach((entry, i) => {
    const summary = readSummaryEntry(entry, "agents", i, errors);
    if (!summary) return;
    const bin = isRecord(entry) ? entry.bin : undefined;
    if (bin === undefined) {
      read.push(summary);
      return;
    }
    if (typeof bin !== "string" || !CONTRIB_ID.test(bin)) {
      errors.push(
        `contributes.agents[${i}]: bin must be a plain program name (alphanumerics, "-" or "_")`,
      );
      return;
    }
    read.push({ ...summary, bin });
  });
  return read.length > 0 ? read : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
