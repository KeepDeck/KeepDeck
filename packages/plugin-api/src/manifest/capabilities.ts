/**
 * Capabilities — what a plugin declares it needs from the platform. The
 * manifest lists them, the user consents at install, and the host checks the
 * declaration on EVERY service call (the Zed model: declaration in the
 * manifest, a granter at the call site). A plugin with an empty list is pure
 * UI: it can render and store its own state, but no service will serve it.
 *
 * The union is closed on purpose: an unknown `kind` is a manifest ERROR, not
 * an ignorable extra — capabilities are the one place a tolerant read would
 * be a security bug.
 */
import type { JsonValue } from "../json.ts";

/** A long-lived helper the host keeps for the plugin: one of its declared
 * `commands`, speaking newline-delimited JSON-RPC 2.0 over stdio. The host
 * starts it on first use, performs the handshake itself, and passes on only
 * the methods named here — consent lists them verbatim. */
export interface RpcServerDeclaration {
  /** Unique in the manifest; what `services.rpc.request` names. */
  id: string;
  /** One of this capability's `commands` — a name, not a path. */
  command: string;
  /** The fixed argument list. */
  args: string[];
  /** Run once per child, by the host: request `method`, then send the
   * notification `then`. Neither is ever callable by the plugin. */
  handshake?: { method: string; params?: JsonValue; then?: string };
  /** The ONLY methods a call may name. */
  methods: string[];
}

/** A value chosen by a declared environment variable, with a literal
 * fallback used when the variable is unset or exactly empty. No
 * interpolation, no shell, no nesting: one name and one default. A
 * non-empty value that does not fit is an error, never a quiet fallback. */
export interface EnvDefault {
  /** A name the plugin's `env` capability declares. */
  env: string;
  default: string;
}

/** A `net` domain: a literal `host[:port]` (both schemes), or the ORIGIN
 * of an http(s) URL a declared variable chooses — exactly its scheme, host
 * and port; its path grants nothing. */
export type NetDomain = string | EnvDefault;

/** Where a credential source's token files live: an absolute or `~/` path,
 * or one a declared variable chooses (a relative value resolves against the
 * app's launch directory, as the CLI reading the same variable would),
 * optionally with a fixed relative `append`. Resolved once, natively. */
export type CredentialDirectory = string | (EnvDefault & { append?: string });

/** Tokens the HOST reads on the plugin's behalf and sends as
 * `Authorization: Bearer` — only to the origins of the `net` entry that
 * declares this source. The plugin never sees the token. */
export interface CredentialSource {
  /** Unique across the plugin; what `services.http.get` names. */
  id: string;
  dir: CredentialDirectory;
  /** JSON string fields tried in order; the first non-empty one is the token. */
  tokenFields: string[];
}

export interface LegacyDownloadMigration {
  source: string;
  target: string;
  stripSingleRoots?: boolean;
}

export type Capability =
  /** Run the listed commands — in a PTY session (`sessions.spawn`) or
   * without one (`exec.runOnce`). Entries are matched against the command
   * about to run, by exact name or by the last segment of a path.
   *
   * There is no wildcard. An earlier version of this sentence promised that
   * `*` matched any command; `execCovers` never implemented it and no
   * manifest ever declared it, so the promise is gone rather than taught —
   * granting every command is not a thing to add for an absent caller.
   *
   * WHAT THIS GRANTS, stated because the short name understates it. The
   * environment a plugin passes is NOT filtered beyond loader hygiene, the
   * arguments are not bounded at all, and a CLI that loads its own config
   * and extensions will load whatever it is pointed at. For an agent CLI
   * that adds up to something close to "may run code as the user": both
   * `<cli> -p "<anything>"` and a config naming a plugin file are inside
   * this capability, not around it.
   *
   * That is a DECISION, not an oversight. Narrowing it was designed out in
   * full — declaring allowed env names in the manifest, deriving them from
   * the plugin's id, filtering at the process leaf, restricting commands to
   * a plugin's own folder — and every one either failed (the manifest and
   * the id are both written by the plugin author) or bought a rule the
   * installed base does not need yet. The trust boundary is INSTALLATION:
   * a person decides which plugins run, and this capability tells them
   * which programs those plugins may start.
   *
   * Revisit if third-party plugins become a real population — today none
   * exist, which is exactly why the contract is cheap to change later.
   *
   * `servers` adds helpers the host keeps running (`services.rpc`). They
   * narrow nothing above — a declared command may already be run with any
   * arguments — but the primitive itself carries only the listed methods,
   * so it never becomes a general pipe into a logged-in CLI. */
  | { kind: "exec"; commands: string[]; servers?: RpcServerDeclaration[] }
  /** Read project files. `workspace` = the workspace folder and its panes'
   * worktrees; `everywhere` = no path restriction (consent shouts this). */
  | { kind: "fs"; scope: "workspace" | "everywhere" }
  /** Read git state (status, diffs) of project repositories — read-only, the
   * same path scoping as `fs`. Writing (stage/commit) would be its own
   * capability; it deliberately does not exist yet. */
  | { kind: "git"; scope: "workspace" | "everywhere" }
  /** WRITE files under the declared absolute path prefixes (a leading `~/`
   * expands to the user's home). The read `fs` capability deliberately has
   * no write surface; this one exists for agent plugins' session-store
   * surgery (fork/relocate) and is scoped to exactly the store paths the
   * plugin names — consent lists them verbatim. */
  | { kind: "fsWrite"; paths: string[] }
  /** Run read-only SELECTs against database files under the declared path
   * prefixes — for agent stores that are SQLite, where `fs` reads are
   * useless on the binary blob. Opened READ-ONLY host-side. */
  | { kind: "sqliteReadonly"; paths: string[] }
  /** Network access from the plugin's own realm, enforced via the realm's
   * CSP, and for `downloads` and `services.http`. Domains are literal hosts
   * or a declared variable's origin; `*` is deliberately not supported.
   * `credentials` lets the host sign `services.http` requests to THIS
   * entry's domains with a token it reads itself. */
  | { kind: "net"; domains: NetDomain[]; credentials?: CredentialSource[] }
  /** Read these environment variables, by name, from the app's own startup
   * environment (`services.env`) — and let a `net` domain or credentials
   * directory refer to them. Nothing undeclared is readable; consent names
   * every one. */
  | { kind: "env"; names: string[] }
  /** Declarative, host-run migration for artifacts created before plugins
   * owned their private storage. Reserved for bundled plugins. */
  | { kind: "legacyDownloads"; migrations: LegacyDownloadMigration[] }
  /** Allocate deterministic port blocks (`ports_allocate`). */
  | { kind: "ports" }
  /** Open URLs in the default browser / files in their default app via the
   * opener service — outward-facing side effects on the user's machine. */
  | { kind: "open" }
  /** Execute OTHER namespaces' commands through the command registry.
   * Patterns are exact registry ids (`agent.spawn`) or a namespace with a
   * trailing wildcard (`agent.*`); a bare `*` is invalid — consent must show
   * what it actually covers. A plugin's own commands need no declaration. */
  | { kind: "commands"; execute: string[] }
  /** Capture microphone audio and run LOCAL speech-to-text on it (the voice
   * service). Consent names the microphone; audio never leaves the machine. */
  | { kind: "mic" }
  /** Post notifications through the host's notification center (`ctx.notify`)
   * — including OS banners, per the user's delivery settings. The host
   * attributes every entry with the plugin's name and rate-limits the flow;
   * the user can mute one plugin without disabling it. */
  | { kind: "notifications" }
  /** Write text to the OS clipboard (`ctx.services.clipboard.writeText`) over
   * the host's single native path — outward only, like a copy. Split from
   * `clipboardRead` so consent is granular: a copy-only plugin never gets the
   * more sensitive read (mirrors the `fs` / `fsWrite` split). */
  | { kind: "clipboardWrite" }
  /** Read the OS clipboard's text (`ctx.services.clipboard.readText`) — a
   * SENSITIVE capability: the clipboard holds arbitrary user data (passwords,
   * secrets), so a plugin that reads it can exfiltrate. Deliberately separate
   * from `clipboardWrite` so a plugin declares exactly the direction it needs;
   * the host's own panes follow the same stance (a pane must NOT read the
   * clipboard). */
  | { kind: "clipboardRead" };

/** All manifest-legal capability kinds — the validator's source of truth. */
export const CAPABILITY_KINDS = [
  "exec",
  "fs",
  "fsWrite",
  "git",
  "sqliteReadonly",
  "net",
  "env",
  "legacyDownloads",
  "ports",
  "open",
  "commands",
  "mic",
  "notifications",
  "clipboardWrite",
  "clipboardRead",
] as const;
