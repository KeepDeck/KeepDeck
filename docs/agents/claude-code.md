# Claude Code

Checked 2026-10-19 against Claude Code 2.1.302. There is no source, so CLI
facts come from probes and from the strings of the installed binary, and say
which.

## Per-spawn injection

Claude takes everything KeepDeck needs on the command line of one process.
Nothing is written to `~/.claude`.

- `--settings <inline JSON>` arms the reporters. Hooks in it **merge per
  event** with the user's own settings (verified on 2.1.198). The
  `statusLine` key does not merge, so KeepDeck takes it, and its reporter
  runs the user's own statusLine at runtime and passes its output through.
- `--plugin-dir <dir>` loads KeepDeck's staged skills as a local plugin. It
  is additive next to the user's installed plugins, and the skills appear as
  `keepdeck-skills:<name>`.
- `--mcp-config '<json>'` injects KeepDeck's MCP servers.
- `--dangerously-skip-permissions` for permission-skipping panes.
- `CLAUDE_CODE_DISABLE_ARTIFACT`, from a plugin setting, passed in env.

`stageLaunch` in `src/index.ts` is the single carrier for spawn, resume and
fork.

## Hooks

The reporter scripts are the shared ones from `resources/reporters/`.

| Event | Used for | Asks for mail |
|---|---|---|
| `SessionStart` | session identity (session hook), and the team brief | yes |
| `UserPromptSubmit` | turn start | yes |
| `PostToolBatch` | mid-turn mail; fires once per batch of tool calls | yes |
| `Stop` | turn end | yes |
| `StopFailure` | turn failed | no |
| `Notification` | waits: only `permission_prompt` and `agent_needs_input` | no |
| `PostToolUse`, `PostToolUseFailure` | an approval was resolved | no |
| `SubagentStart`, `SubagentStop` | brackets for agents running beside the main thread | no |

Notes:

- **Interrupts have no hook.** Esc is seen only in the transcript, which
  KeepDeck tails (`src/tail.ts`).
- **Subagent hooks carry `agent_id`.** A subagent's `PostToolUse` still
  clears the pane's approval wait on purpose: the wait is not tagged with who
  raised it, because `Notification` carries no agent id.
- **Mail continues the turn.** When a `Stop` reply hands over mail, Claude
  continues instead of stopping. The normalizer reads the delivered reply and
  reports the turn as still running.

## Steering

Input typed during a running turn is folded into it at the next tool batch
(`queued_command` attachments, "absorbed mid-turn"), not held to the end of
the turn. Read from the binary, not verified live. KeepDeck does not need
this for mail, because `PostToolBatch` already collects mail mid-turn.

## Sessions and fork

Transcripts live at `~/.claude/projects/<slug(cwd)>/<id>.jsonl`. When an id
collides, Claude moves the other file aside as `<id>.orphaned-…`. History
skips those files.

Fork into another directory copies the transcript into the target
directory's slug folder, then starts `--resume <id> --fork-session` there.
Claude mints a new id and the original stays resumable. Claude 2.1.302 also
accepts an absolute transcript path in `--resume`, which would remove the
copy; that is open work.

`claude agents --json` lists live sessions (`src/liveSessions.ts`).

## Usage

- The statusLine reporter delivers rate limits, cost, model, context window
  and last-turn tokens, both on events and on a timer.
- Session token totals come from the transcript (assistant records,
  de-duplicated by message id), including subagent transcripts in
  `<transcript>/subagents/`.
- Claude reports cost itself, so KeepDeck shows it.
