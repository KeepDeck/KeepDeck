# Codex

Checked 2026-10-19 against codex-cli 0.163.0 (tag `rust-v0.163.0` of
`openai/codex`) and the installed binary. Codex's `main` branch moves fast
and runs ahead of releases; check claims against the tag of the version you
target.

## Per-spawn injection

- **Hooks:** `-c hooks.<Event>=[…]` plus a single `-c hooks.state={…}` that
  carries a `trusted_hash` for each hook. Codex refuses untrusted hooks.
  KeepDeck computes the hash exactly as Codex does (`src/trust.ts`).
  - The hash covers the hook's normalised identity, including its timeout.
    The default timeout is 600 s, except `Interrupt` and `SessionEnd`, which
    default to 1 s and are clamped to 1–3 s. A hash computed with the wrong
    timeout makes Codex skip the hook silently. Verified live.
  - The trust key is per handler: `<layer>:<event>:<group>:<handler>`.
  - A repeated `-c hooks.state=` replaces the earlier one, so all trust goes
    in one table.
  - Hooks are **additive across config layers**. The user's own
    `config.toml` hooks run alongside KeepDeck's.
- **MCP:** one `-c mcp_servers.<name>={…}` TOML inline table per server.
- **`-c disable_paste_burst=true`.** It stops Codex collapsing fast typed
  input, such as voice dictation, into a non-editable paste placeholder.
- **`--dangerously-bypass-approvals-and-sandbox`** for permission-skipping
  panes.
- **`--remote <endpoint>`** for panes targeting a native server.
- **Skills:** Codex has no flag or env for them. It reads `.agents/skills`
  from its starting directory, and the host symlinks the staged skills there
  before the spawn.

`-c` flags are global and must come before the `resume` or `fork`
subcommand.

## Hooks

| Event | Used for | Asks for mail |
|---|---|---|
| `SessionStart` | session identity | no |
| `UserPromptSubmit` | turn start | yes |
| `PostToolUse` | mid-turn mail, and the backstop for a resolved approval | yes |
| `Stop` | turn end | yes |
| `PermissionRequest` | approval wait | no |
| `Interrupt` | the user's Esc, at once | no |
| `PostCompact` | the context was rebuilt, which clears a recorded failure | no |

Notes:

- **Output schema changed in 0.147.0.** Codex adopted Claude's hook-output
  schema. The mail renderer chooses the schema from the CLI's `--version`.
- **Subagents** carry `agent_id` and `agent_type` in their hook payloads,
  while the main agent's carry neither. `session_id` is shared, so it does
  not tell them apart. A subagent ends with `SubagentStop`, not `Stop`, but
  its `UserPromptSubmit` and `PostToolUse` reach KeepDeck (verified live).
  They move nothing and take no mail.
- **`Interrupt`** exists since 0.150 and fires on the user's Esc on the main
  thread. Hashed with its 1 s timeout, it reports the interruption at once.
  The rollout's `turn_aborted` stays the fallback for older Codex and for
  other abort reasons.
- **SessionStart `source`** can be `startup`, `resume`, `clear`, `compact` or
  `fork`, and the deck's binding understands all of them. SessionStart runs
  at the first turn, not at process start.
- **Long `additionalContext`** is cut to a head-and-tail preview with the
  full text in a file. KeepDeck arms its mail hooks with
  `additionalContextLimit=0`, which keeps the context whole on
  `UserPromptSubmit` and `PostToolUse`. `Stop` ignores the limit and still
  spills a long message; Codex drops the field there before hashing, so
  `trust.ts` declares it only where Codex keeps it. Verified live.

- **Twelve hook events in 0.163.** The other three, `PreToolUse`,
  `PreCompact` and `SessionEnd`, carry nothing the pane needs. There is no
  hook for notifications, idle or a failed turn; failures come from the
  rollout's `task_complete`.
- **A manual compaction** after a failed turn runs no prompt or stop hook.
  `PostCompact` is the only edge that reports it. Verified live.
- **Known limitation: background subagent work is invisible.** The main
  agent can finish its turn (`Stop`) while a subagent keeps working, and the
  subagent survives the main agent's Esc, but the pane shows "done". Hooks
  cannot bracket a subagent's work: a repeated message to it fires no new
  `SubagentStart`, closing it fires no hook, and a blocked `SubagentStop`
  keeps it running in the same turn. Verified live.

## Steering

Steering is always on: input typed during a running turn becomes pending
input of that turn, and `UserPromptSubmit` runs on it. The payload has no
steer flag, but its `turn_id` is the running turn's id. Read from source.

## Sessions and fork

Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`;
the uuid is the session id.

An experimental, default-off feature (`local_thread_store_compression`)
compresses rollouts older than 7 days to `.jsonl.zst`. Codex decompresses
them on resume. KeepDeck's history only matches `.jsonl`, so with the
feature on, old sessions would disappear from KeepDeck's history. That is
open work.

Fork uses Codex's own `codex fork <id>`.

## Usage

- Tokens, context and rate limits come from the rollout's `token_count`
  events.
- Account limits are also read from a KeepDeck-owned `codex app-server`
  (`account/rateLimits/read`).
- There is no dollar cost for ChatGPT-plan accounts. Per-thread cost
  (`account/usage/read {threadId}`) is returned only for enterprise
  workspaces; it was null on a regular plan, verified live.
