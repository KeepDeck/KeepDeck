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
import { sha256Hex } from "@keepdeck/plugin-api";

/** One hook to arm: the codex event name (CamelCase, as `hooks.<Event>`
 * keys it), the shell line to run, and — where the event can emit
 * `additionalContext` — the token threshold past which codex spills it to a
 * file (`0` never spills). */
export interface HookRule {
  event: string;
  command: string;
  additionalContextLimit?: number;
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
    const declared = contextLimitOf(rule);
    const limit = declared === undefined ? "" : `,additionalContextLimit=${declared}`;
    args.push(
      "-c",
      `hooks.${rule.event}=[{hooks=[{type="command",command=${tomlBasicString(rule.command)}${limit}}]}]`,
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

/**
 * codex's own hook timeout, in seconds, applied when a hook declares none.
 *
 * NOT a number this file chose — it is codex's default, and reproducing it
 * is mandatory: the fingerprint below is taken over the NORMALIZED hook, so
 * a value that disagrees with codex's produces a hash codex rejects, and a
 * rejected hook is refused in silence. It is stated here rather than buried
 * in the literal because it is also the answer to "how long may our reporter
 * run": ten minutes, against the ~2s it actually waits for the deck. That
 * margin is why codex needs no timeout of ours, while claude — whose default
 * we cannot read — is given one explicitly.
 *
 * If codex ever changes it, hook trust breaks first and everything armed
 * through this module goes quiet. That is the symptom to recognise.
 */
export const CODEX_HOOK_TIMEOUT_SECONDS = 600;

/** The default for the two events codex runs while it is shutting a turn or
 * a session down — `Interrupt` and `SessionEnd` — which it also clamps to
 * 1..3 s (hooks/src/engine/discovery.rs, normalize_command_hook, 0.163.0).
 * Hashing one of them with the general 600 makes codex skip it in silence:
 * verified live. */
const SHUTDOWN_HOOK_TIMEOUT_SECONDS = 1;

/** The events codex lets emit `additionalContext` — the only ones whose
 * `additionalContextLimit` it keeps. On any other it drops the field before
 * hashing, so declaring it there would trust a hook codex never sees: `Stop`
 * spills a long reason whatever the limit (verified live on 0.163.0). */
const CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
]);

/** A rule's context limit as codex normalizes it: kept only where the event
 * can emit context. */
function contextLimitOf(rule: HookRule): number | undefined {
  return CONTEXT_EVENTS.has(rule.event) ? rule.additionalContextLimit : undefined;
}

/** The timeout codex normalizes a hook declaring none to, by event. */
export function codexHookTimeout(event: string): number {
  return event === "Interrupt" || event === "SessionEnd"
    ? SHUTDOWN_HOOK_TIMEOUT_SECONDS
    : CODEX_HOOK_TIMEOUT_SECONDS;
}

/** codex's fingerprint of the normalized hook identity:
 * `sha256:<hex>` over the compact, KEY-SORTED JSON of
 * `{event_name, hooks:[{additionalContextLimit?, async, command, timeout,
 * type}]}` — defaults applied ([`codexHookTimeout`], `async` false), `None`
 * fields omitted, matcher absent. JSON.stringify preserves insertion order,
 * so the literals below are written in alphabetical key order to match
 * serde_json's sorted map. */
export async function trustedHash(rule: HookRule): Promise<string> {
  const identity = {
    event_name: snakeCase(rule.event),
    hooks: [
      {
        ...(contextLimitOf(rule) === undefined
          ? {}
          : { additionalContextLimit: contextLimitOf(rule) }),
        async: false,
        command: rule.command,
        timeout: codexHookTimeout(rule.event),
        type: "command",
      },
    ],
  };
  return `sha256:${await sha256Hex(JSON.stringify(identity))}`;
}

/** `SessionStart` → `session_start` — the state-key/fingerprint spelling. */
function snakeCase(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** A TOML basic string (double-quoted, `\` and `"` escaped). */
function tomlBasicString(value: string): string {
  return `"${value.split("\\").join("\\\\").split('"').join('\\"')}"`;
}
