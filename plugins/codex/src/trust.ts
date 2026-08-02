/**
 * Arming codex hooks purely from CLI overrides.
 *
 * codex refuses untrusted hooks unless `[hooks.state.<key>]` carries a
 * `trusted_hash` matching its own fingerprint of the hook's NORMALIZED
 * identity. This module reproduces that fingerprint bit-for-bit (verified
 * against codex-rs `rust-v0.142.5`: `config/src/fingerprint.rs` +
 * `hooks/src/engine/discovery.rs`, re-verified live on 0.146.0) so hooks
 * can be defined AND trusted in one spawn's argv, never touching the
 * user's `~/.codex/config.toml`.
 *
 * Three upstream sharp edges are encoded here:
 * - the hook `command` is a SHELL LINE (run via `$SHELL -lc`), not argv;
 * - the `-c` dotted-path splitter has no quoting, so `hooks.state` must be
 *   passed as ONE inline-table value with the state keys as quoted strings;
 * - a repeated `-c hooks.state=` REPLACES the earlier one wholesale, so
 *   every armed event's trust must ride in that one table — which is why
 *   this module takes the whole rule list at once.
 */

/** One hook to arm: the codex event name (CamelCase, as `hooks.<Event>`
 * keys it) and the shell line to run. */
export interface HookRule {
  event: string;
  command: string;
}

/** The trust-state key for a hook defined via `-c` (the SessionFlags
 * layer): `<layer path>:<event>:<matcher-group index>:<handler index>`,
 * with the event in snake_case — a codex quirk (the config key is
 * CamelCase, the state key is not). */
export function sessionFlagsStateKey(event: string): string {
  return `/<session-flags>/config.toml:${snakeCase(event)}:0:0`;
}

/** The `-c` override args that define and trust the given hooks: one
 * `hooks.<Event>` per rule, then ONE combined `hooks.state` table trusting
 * them all. Prepend to the spawn args (global flags precede subcommands). */
export async function cliArgs(rules: readonly HookRule[]): Promise<string[]> {
  const args: string[] = [];
  for (const rule of rules) {
    args.push(
      "-c",
      `hooks.${rule.event}=[{hooks=[{type="command",command=${tomlBasicString(rule.command)}}]}]`,
    );
  }
  const entries = await Promise.all(
    rules.map(
      async (rule) =>
        `"${sessionFlagsStateKey(rule.event)}" = {trusted_hash = "${await trustedHash(rule)}"}`,
    ),
  );
  args.push("-c", `hooks.state={${entries.join(", ")}}`);
  return args;
}

/** codex's fingerprint of the normalized hook identity:
 * `sha256:<hex>` over the compact, KEY-SORTED JSON of
 * `{event_name, hooks:[{async, command, timeout, type}]}` — defaults
 * applied (`timeout` 600, `async` false), `None` fields omitted, matcher
 * absent. JSON.stringify preserves insertion order, so the literals below
 * are written in alphabetical key order to match serde_json's sorted map. */
export async function trustedHash(rule: HookRule): Promise<string> {
  const identity = {
    event_name: snakeCase(rule.event),
    hooks: [
      { async: false, command: rule.command, timeout: 600, type: "command" },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** `SessionStart` → `session_start` — the state-key/fingerprint spelling. */
function snakeCase(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Quote a path for use inside the hook's shell command line (single quotes,
 * `'\''` escaping) — KeepDeck.app can live under a path with spaces. */
export function shellQuote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

/** A TOML basic string (double-quoted, `\` and `"` escaped). */
function tomlBasicString(value: string): string {
  return `"${value.split("\\").join("\\\\").split('"').join('\\"')}"`;
}
