# Claude Code

Checked 2026-10-19 against Claude Code 2.1.302; the fork and Mod sections
against 2.1.303, background workers on 2026-10-20. There is no source, so CLI
facts come from probes and from the strings of the installed binary, and say
which.

## Per-spawn injection

Claude takes everything KeepDeck needs on the command line of one process.
Nothing is written to `~/.claude`.

- `--settings <inline JSON>` arms the reporters. Hooks in it **merge per
  event** with the user's own settings (verified on 2.1.198). Each hook is
  in exec form, `{command: "/bin/sh", args: [script, "claude", …]}`, so no
  shell parses the script's path. `args` exists since 2.1.139; 2.1.138
  ignores it and runs the bare `/bin/sh` on the hook's JSON (measured), so
  KeepDeck needs claude 2.1.139 or newer. The reporter's identity is
  unchanged: the script's parent is claude itself (verified on 2.1.303).
  The `statusLine` key does not merge, so KeepDeck takes it, and its
  reporter runs the user's own statusLine at runtime and passes its output
  through. `statusLine` takes no `args`, so it stays a shell string.
- `--plugin-dir <dir>` loads the shared skills as a local plugin. The plugin
  builds that directory itself in its own workspace directory
  (`src/skillsPlugin.ts`: `.claude-plugin/plugin.json` and
  `skills/<name>/SKILL.md`, published whole). It is additive next to the
  user's installed plugins, and the skills appear as `keepdeck-skills:<name>`.
- A second `--plugin-dir` loads KeepDeck's Mod (`resources/keepdeck-mod`,
  plugin `keepdeck-reporter`), and the inline settings keep it on with
  `enabledPlugins: {"keepdeck-reporter@inline": true}` even where the user
  switched it off. The bare name does not override a user's `false`.
  Verified live. The user's `disableAllHooks` and simple and safe modes are
  left alone, and a managed policy wins.
- `--mcp-config '<json>'` injects KeepDeck's MCP servers.
- `--dangerously-skip-permissions` for permission-skipping panes.
- `CLAUDE_CODE_DISABLE_ARTIFACT`, from a plugin setting, passed in env.

`stageLaunch` in `src/index.ts` is what every launch carries, through the
shared `launchPlans`.

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

- **Interrupts have no hook.** The Mod reports Esc; without it, KeepDeck
  tails the transcript for it (`src/tail.ts`).
- **Subagent hooks carry `agent_id`.** A subagent's `PostToolUse` still
  clears the pane's approval wait on purpose: the wait is not tagged with who
  raised it, because `Notification` carries no agent id. Subagent events
  never collect mail.
- **Mail continues the turn.** When a `Stop` reply hands over mail, Claude
  continues instead of stopping. The normalizer reads the delivered reply and
  reports the turn as still running.

## Mod

A Mod is a JS module claude loads per spawn from a `--plugin-dir` plugin
(`hooks/hooks.json` lists `./register.js`). KeepDeck's Mod does only what
the hooks cannot; everything the hooks report stays with them, mail
included.

- **Hello.** Once per process, a `companion.hello` envelope over the shared
  wire (`resources/reporters/keepdeck-wire.js`), naming the process group
  the way the hook reporters do (`ps -o pgid= -p $PPID` from a child). The
  host counts it only for the process the pane is pinned to.
- **Esc:** `turn.complete` with `reason: "aborted"` and no `agentId`, sent
  as `KeepDeckInterrupt`. One per Esc, mid-stream or mid-tool; none for a
  stopped subagent. None either for a turn cut by a prompt sent while it
  ran: with the Mod's `session.append` hook, claude settles a turn's own
  prompt before its `turn.start`, so a
  prompt accepted while a turn is open is the next turn's, and that turn's
  `turn.complete` (same `turnId`) can arrive after it from claude's serial
  turn-event queue — stating it would end the new turn (2.1.311).
- **Accepted prompt:** `session.append`, observed after claude wrote it,
  `door: "prompt"`, origin `composer`, no `agentId`, a non-meta user row.
  Sent as `KeepDeckPromptAccepted`: one per prompt taken in, idle or
  queued; none for queue staging, plugin-origin prompts or `/compact` rows.
- **One source per process.** A process whose Mod said hello gets no
  transcript status tail; the tail reads usage records only. A process
  without the Mod keeps the tail. The plugin declares this as
  `companion: { covers: ["status-records"] }`.
- **Wake** (`wake: "companion"`). With the Mod present the deck rings the
  pane's doorbell (`mail.wake`) instead of typing. The Mod starts watching
  only once the deck accepted its hello, and polls it every
  100 ms (a Mod cannot watch a file), removes it, and submits the
  terminal's own wake line with `$.prompt.submit`. The mail still rides
  `UserPromptSubmit`'s hook and leaves the queue only then. Right after
  Esc claude refuses a plugin prompt until the user types; nothing is
  lost, the mail stays queued. A ring mid-turn queues one prompt for the
  next turn.
- **Mod limits** (2.1.303): event names and `$` calls are static literals;
  no imports outside the plugin; no `process`, `require` or global `fetch`
  (`$.env`, `$.http.fetch`, `$.fs`, `$.clock`, `$.process` instead). A Mod
  stuck in a CPU loop for 5 s is unloaded for good; a throw or a hang of a
  handler is only skipped.
- **Where Mods do not reach.** `--bare`, `--safe-mode` and
  `disableAllHooks` turn off Mods and hooks alike. On managed or
  Team/Enterprise seats claude's own guard routes classic hook events and
  prompt-context sites past user Mods; the native events the Mod uses are
  not among them (read from the binary). A managed policy can forbid user
  Mods outright; then no hello comes and the pane runs on the tail and the
  terminal.
- **Background workers.** `/bg` and `←` move a conversation into a daemon
  worker under a new id (hook `SessionStart` source `fork`, naming only the
  new id). Verified live on 2.1.303 (task-422):
  - The daemon is started from whichever pane first needs it and detaches
    (`setsid`); every worker is its own session leader under it. Each
    inherits the Mod, the hooks and the bridge of THAT pane, whichever pane
    sent the conversation to the background.
  - `/bg` ends the pane's claude (exit 0). `←` keeps it as a raw client of
    the daemon, which can switch between workers; claude reports none of
    that switching.
  - Nothing a hook or the Mod sees names the conversation a worker
    continues. Only the daemon's private `roster.json` and the copied
    transcript rows do; KeepDeck reads neither.
  - Prewarmed workers report `source=startup` before anyone uses them.

  So a worker never speaks for a pane: the bridge refuses every report from
  outside the pane's terminal (see [README](README.md), report origin), a
  refused Mod watches no doorbell, and the worker's keepdeck MCP calls are
  anonymous, though its injected `--mcp-config` carries the pane's secret
  (it would otherwise read the pane's mail and act in its role). After `/bg` the pane shows its claude
  as exited, and Restart resumes the conversation as it stood at `/bg`;
  the worker goes on in the background and `claude attach <id>` reaches it.

Verified live on 2.1.303 against the shipped files (task-405).

## Steering

Input typed during a running turn is folded into it at the next tool batch
(`queued_command` attachments, "absorbed mid-turn"), not held to the end of
the turn. Read from the binary, not verified live. KeepDeck does not need
this for mail, because `PostToolBatch` already collects mail mid-turn.

## Sessions and fork

Transcripts live at `~/.claude/projects/<slug(cwd)>/<id>.jsonl`. When an id
collides, Claude moves the other file aside as `<id>.orphaned-…`. History
skips those files.

A project folder is named after its directory: every non-alphanumeric
character becomes `-`, and past 200 characters the name is cut there and
`-<base36 hash of the whole path>` is appended (read from the binary,
checked against folders Claude made for 321-character paths).

Fork (`src/fork.ts`), into any directory including the source's own:

- `--resume <id>` looks only in the current directory's project folder, so
  the source transcript is copied there under a throwaway id T, and Claude
  forks it itself: `--session-id F --fork-session --resume T`. F is chosen
  by KeepDeck; Claude accepts `--session-id` with `--resume` only beside
  `--fork-session`, and its own background jobs launch this way. Verified
  live.
- Claude writes F's transcript and moves the file-history snapshots to F
  itself. It does not carry the rest of the session folder: a subagent is
  looked up when it is messaged, under the CURRENT session's folder, and
  the task list (`tasks/<id>/`) is per session. So KeepDeck copies the
  folder's `subagents/`, `tool-results/`, `workflows/` and
  `custom-title.json`, and the task list, to F before the start. Verified
  live: the fork messages an old subagent and reads a spilled output after
  the source is gone.
- Histories name those files by absolute path, so every copied transcript
  has the source folder's path replaced by F's, JSON-escaped.
- T is removed once the fork reports F; while it exists Claude's history
  lists the conversation twice. Removing it at the fork's `SessionStart`
  is safe for later turns, resume, the `/resume` picker and rewind.
  Verified live. If the fork never starts, T, F's folder and F's task list
  are removed, and with them a project folder that held nothing else.
- The store must sit under `~/.claude`: the manifest's write prefixes are
  `~/.claude/projects` and `~/.claude/tasks`, so a fork of a store moved
  elsewhere with `CLAUDE_CONFIG_DIR` is refused by the host.
- Not carried: remote agents, async MCP tasks, remote-sync, auto-mode and
  recording files. They belong to jobs the source still owns. The plan
  file is keyed by its name, not the session, so the fork shares it, as
  Claude's own fork does.
- Not affected: `uploads/` is never written by local input (clipboard
  images, dropped paths, `@` mentions, read PDFs; checked live). Images
  live inside the transcript.

Claude also accepts an absolute transcript path in `--resume`. KeepDeck
does not use it.

`claude agents --json` lists live sessions (`src/liveSessions.ts`).

## Usage

- The statusLine reporter delivers rate limits, cost, model, context window
  and last-turn tokens, both on events and on a timer.
- Session token totals come from the transcript (assistant records,
  de-duplicated by message id), including subagent transcripts in
  `<transcript>/subagents/`.
- Claude reports cost itself, so KeepDeck shows it.
