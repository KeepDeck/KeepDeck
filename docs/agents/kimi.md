# Kimi Code

Checked 2026-10-19 against Kimi Code 2.2.0, both the native binary and the
source of the `MoonshotAI/kimi-code` repository.

## No per-spawn hook door

Claude Code takes hooks from `--settings` and Codex takes them from `-c`.
Kimi has no flag or env that adds hooks for one process. KeepDeck instead
installs two **companion plugins** into the user's Kimi home. They are inert
outside a KeepDeck pane: the scripts do nothing without KeepDeck's env.

- `keepdeck-session-reporter` runs the shared reporter scripts on these
  events:

  | Event | Script | Asks for mail |
  |---|---|---|
  | `SessionStart` | session hook | no |
  | `UserPromptSubmit` | status hook | yes |
  | `Stop` | status hook | no |
  | `StopFailure` | status hook | no |
  | `Interrupt` | status hook | no |
  | `PermissionRequest` | status hook | no |
  | `PermissionResult` | status hook | no |

- `keepdeck-teams` ships the team skill.

Installation goes through a short-lived `kimi web` server and its public
plugin API: `GET /api/v1/plugins`, `POST /api/v1/plugins {source}`, and
`POST /api/v1/plugins/<id>:enable` and `:remove`. The API needs the bearer
token from the server's banner and exists since Kimi 0.36.1. It replaced the
`--debug-endpoints` RPC. The code is in `manager.ts`, `serverManager.ts` and
`serverWrapper.ts`.

## Launch

`stageLaunch` in `index.tsx` is what every launch carries, through the
shared `launchPlans`. Resume adds `--session <id>`; fork clones the session
and adds `--session <new id>`. The launch carries:

- `--skills-dir <dir>` when KeepDeck has staged skills. It **replaces** Kimi's
  own skill discovery rather than adding to it, so it is passed only when
  there is something to stage.
- `--yolo` for permission-skipping panes.
- `--session <id>` to resume or to open a fork.
- `KIMI_CODE_TRUST_WORKSPACE=1` as an env **default**, so a value the user
  set wins. Since 2.2, Kimi stops every directory it has not seen on a
  blocking "Trust this folder?" prompt. Trusting the directory also lets
  Kimi start that project's own MCP servers (`.kimi-code/mcp.json`,
  `.mcp.json`), eagerly, before any session exists. That was accepted as a
  product decision.

Kimi has no flag for injecting KeepDeck's MCP servers. It reads them from
`.kimi-code/mcp.json` in its cwd, so the plugin renders that file
(`src/mcp.ts`) and declares it through `arm.plan`; the host plants it beside
a `.keepdeck-managed` marker, refuses a folder whose file is the user's, and
takes it back when no pane needs it. The manifest marks `integration.mcp`
with `delivery: "cwd"`: one file per directory, so panes sharing a cwd get
an anonymous keepdeck client rather than whichever secret was written last.

Kimi starts every child detached on macOS and Linux (`detached ??
!isWindows` in its host process service), MCP servers included, so its
keepdeck shim runs in a session of its own with kimi as its parent. That is
why a pane's MCP client counts when its PARENT runs in the pane's terminal
(see [README](README.md), report origin). Verified live on 2.2.0
(2026-10-20, task-424).

## `/new` binds the pane to the new session

`/new` and `/clear` fire SessionStart at once with `source: startup` from
the pane's own process (2.3.0). The deck used to refuse that as a second
session (`second-startup`), and the pane stayed on the old one.
`src/binding.ts` says such a startup is the user's new conversation: in the
pane's process only the user's own new sessions report `startup` (`/new`,
`/clear`, the model switch's "new", the session picker's fallback).
Subagents report `SubagentStart`, and `/fork` reports its root as `resume`.
A nested `kimi -p` or `kimi acp` from the agent's Bash tool or the user's
`!` stays refused: kimi spawns that shell detached (`buildSpawnOptions`,
`detached` on everything but Windows), so it is another process group, and
the MCP servers are detached as well (measured on 2.3.0). The residual risk:
a root session made by a child kimi starts in its own group, or a future
same-process root creator, would be accepted too (task-450).

`/fork` on 2.3.0 creates a root session and fires SessionStart with
`source: resume` from the pane's own process while the TUI stays on the
original. The deck reads `resume` as a swap, so the pane moves to the fork
the user is not in (task-454).

## Hook output: what Kimi reads, what it drops

This is a design choice of Kimi's, not a bug, and the reason several things
that work on other CLIs do not work here.

- Output is consumed only from `UserPromptSubmit`, `Stop` and `PreToolUse`.
  Every other event is fire-and-forget: anything the hook prints is ignored.
- `UserPromptSubmit` takes `{"message": "<text>"}`, which is appended to the
  turn. It runs only for prompts of origin `user`, never for a subagent's.
- `Stop` takes only a block: `hookSpecificOutput.permissionDecision: "deny"`
  with the text in `permissionDecisionReason`. For `Stop`, "deny" means
  "do not stop", and Kimi continues the turn with that text.
- `PreToolUse` can only veto the tool. The reason becomes the tool's denial
  message, so it cannot carry mail without cancelling the tool.
- A root `additionalContext` and Claude-style `decision`/`reason` are
  silently ignored.
- Newer hook events (`TurnStarted`, `UserPromptQueued`, `TaskStarted`,
  `SessionHeartbeat`) are fire-and-forget. `TurnStarted` has no agent
  identity, and a subagent's turn differs only by
  `origin_name: "subagent"`. Verified live.

The renderer is `renderKimiMail` in `status.ts`.

## Subagents and the anonymous Stop

`Stop` fires at the end of a subagent's turn as well as the main agent's,
and the payload carries no agent field. The fields are only
`hook_event_name`, `session_id`, `cwd`, `client_type` and
`stop_hook_active`. Verified live. Mail handed out at `Stop` could reach a
subagent, so `Stop` does not ask. Kimi's only mail channel is
`UserPromptSubmit`, and a working Kimi pane is woken once its turn ends (see
[mail-delivery.md](mail-delivery.md)). The channels are read from the
companion manifest, so the manifest is the one list.

## Status

- Turn start: `UserPromptSubmit` gives `turn-start`. The session wire's
  `turn.prompt` record, filtered to `agentId: "main"`, gives
  `turn-observed`, which covers turns that started without a user prompt.
- Turn end, failure, interruption: read from the wire's `turn.ended`
  (`completed`, `cancelled`, `blocked`, `failed`), not from hooks. Hooks
  fire for subagents too, and `Stop` is skipped after a Stop continuation.
- Approval waits: `PermissionRequest` and `PermissionResult`. These do carry
  `agent_id`; only `"main"` counts.
- Background work: the wire's `task.started` and `task.terminated` for
  detached tasks.

The wire's `turn.prompt` also carries `origin.kind` (`user`,
`skill_activation`, `task`, `cron_job`, and others), meaning why a turn
started. KeepDeck does not read it today.

## Steering

Plain Enter during a running turn queues the input for the next turn.
Ctrl+S steers it into the running turn. Kimi also steers automatically in
its tower and WaitFor modes. `UserPromptSubmit` has an `is_steer` field, but
2.2.0 sets it only to `false`.

## Sessions

The store is `~/.kimi-code/sessions/wd_<slug>_<sha256(cwd)[:12]>/session_<id>/`,
with `state.json`, `agents/<name>/wire.jsonl` per agent, blobs and logs.
`--session <id>` resolves ids through `~/.kimi-code/session_index.jsonl`.
Since 2.2 a plain TUI creates its session lazily, on the first prompt, while
`--session` and `--continue` create theirs at once.

`state.json` names the directory as `workDir` in older sessions and `cwd`
since 0.38. Version-2 metadata also carries its own `id`, which Kimi trusts
over the folder name.

## Fork into another directory

Kimi's own `kimi fork` stays in the same directory, so KeepDeck clones the
session itself (`fork.ts`, with the rules in `forkRebase.ts`). On 2.2 three
things remember the old place, and all three are rewritten in the clone:

1. `state.json`: the directory, the `id`, and every agent's `homedir`.
2. Every agent's wire: `runtime.set_binding.workspaceId`. Kimi asserts it
   against the session's workspace on restore and refuses to start
   otherwise.
3. The main agent's wire: the rendered system prompt (working directory,
   directory listing, AGENTS.md), saved as `profile.bind` and, by older
   versions, as `config.update` with a `systemPrompt`. It is replayed on
   every resume. The clone replaces `profile.bind` line for line with an
   empty `config.update`, a no-op, and strips the profile fields from
   `config.update`. With no saved prompt, Kimi renders a fresh one for the
   new directory, and the profile, model and thinking reset to defaults.

Wires are rewritten line for line: Kimi addresses records by line number and
stops reading at the first line that does not parse. Subagent prompts are
kept, because Kimi does not re-render them. The original session is never
modified. Verified live on 2.2.0.

## Usage

- Tokens and context come from the wire's `usage.record` and `llm.request`.
  Records with `usageScope: "session"` are compaction: they count toward
  cost but are not the context size.
- Rate limits are polled from `<base>/usages` with the token Kimi keeps under
  `credentials/`. The base URL and token file come from Kimi's `config.toml`,
  under `providers."managed:kimi-code"` (`base_url`, `oauth.key`). The values
  differ by login: a mainland-China login uses `api.kimi.com` and
  `kimi-code.json`, a global login uses `api.kimi.ai` and
  `kimi-code-env-<hash>.json`. The code is in the plugin's `src/limits.ts`.
  The plugin parses `config.toml` itself and asks for the usages through
  `services.http`: the host reads the token, confined to the credentials
  directory the manifest declares, and the plugin never sees it.
- `KIMI_CODE_HOME` and `KIMI_CODE_BASE_URL` apply as they do for Kimi. The
  manifest declares both (`env`); the credentials directory and the extra
  origin are resolved from them once, at startup. History lists the store
  under `KIMI_CODE_HOME` too. A fork of such a session is refused when it
  writes, because writes stay limited to `~/.kimi-code`.
