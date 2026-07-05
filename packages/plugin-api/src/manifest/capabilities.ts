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
export type Capability =
  /** Spawn PTY sessions running the listed commands. Entries are matched
   * against the command about to run; `*` matches any single command name —
   * reserved for built-ins, external installs surface it loudly in consent. */
  | { kind: "exec"; commands: string[] }
  /** Read project files. `workspace` = the workspace folder and its panes'
   * worktrees; `everywhere` = no path restriction (consent shouts this). */
  | { kind: "fs"; scope: "workspace" | "everywhere" }
  /** Network access from the plugin's own realm, enforced via the realm's
   * CSP. Domains are literal hosts; `*` is deliberately not supported. */
  | { kind: "net"; domains: string[] }
  /** Allocate deterministic port blocks (`ports_allocate`). */
  | { kind: "ports" };

/** All manifest-legal capability kinds — the validator's source of truth. */
export const CAPABILITY_KINDS = ["exec", "fs", "net", "ports"] as const;
