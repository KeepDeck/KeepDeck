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
export interface LegacyDownloadMigration {
  source: string;
  target: string;
  stripSingleRoots?: boolean;
}

export type Capability =
  /** Spawn PTY sessions running the listed commands. Entries are matched
   * against the command about to run; `*` matches any single command name —
   * reserved for built-ins, external installs surface it loudly in consent. */
  | { kind: "exec"; commands: string[] }
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
   * CSP. Domains are literal hosts; `*` is deliberately not supported. */
  | { kind: "net"; domains: string[] }
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
  | { kind: "notifications" };

/** All manifest-legal capability kinds — the validator's source of truth. */
export const CAPABILITY_KINDS = [
  "exec",
  "fs",
  "fsWrite",
  "git",
  "sqliteReadonly",
  "net",
  "legacyDownloads",
  "ports",
  "open",
  "commands",
  "mic",
  "notifications",
] as const;
