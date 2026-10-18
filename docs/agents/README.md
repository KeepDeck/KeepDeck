# Agent integrations

KeepDeck runs four coding-agent CLIs in its panes: Claude Code, Codex,
Kimi Code and OpenCode. Each one is a built-in plugin under `plugins/<cli>`.
This directory explains how those integrations work and why. It is written
for people and agents who change that code without the history behind it.

These documents describe mechanisms and the reasons for them. They are not
a substitute for reading the code, and they go stale: every file says which
CLI version it was checked against and when. Where a fact was measured on a
running CLI it says "verified live"; where it was read from the CLI's source
or binary it says so.

## How an integration is shaped

Every mechanism has the same two layers:

- **A shared core** in `packages/plugin-api` and the host (`src/`), which
  owns the behaviour: the pane status machine, the mail queue, question
  correlation, history paging, tail reading.
- **An adapter per CLI** in `plugins/<cli>`, which owns only that CLI's
  dialect: its flags and env, its hook payload shapes, where it stores
  sessions, how it forks.

The rule is that the high level works the same for all four CLIs. A new
mechanism gets one core and four adapters, never a helper for "the similar
three" with the odd one on its own path. Work on pulling the remaining
duplicated logic into that shape is tracked as the "Agent plugins: shared
core" epic.

## What a plugin provides

| Concern | What the adapter supplies |
|---|---|
| Launch | `spawn.plan`, `resume.plan`, `fork.plan`: args, env, env defaults |
| Status | a normaliser from the CLI's hook events and store records to pane status edges |
| Mail | a renderer that turns waiting messages into the CLI's hook output, and the hook events that collect mail |
| History | listing and reading the CLI's own session store |
| Fork | moving a session into another working directory |
| Usage | token, context and rate-limit normalisers |
| MCP | injecting KeepDeck's MCP servers per spawn |

KeepDeck never edits a CLI's global configuration. Everything it injects
travels per spawn, through flags or env, or through a companion plugin that
stays inert outside a KeepDeck pane.

## Documents

- [mail-delivery.md](mail-delivery.md): how a teammate's message reaches an
  agent, and when.
- [kimi.md](kimi.md): Kimi Code.
- Claude Code, Codex, OpenCode: not written yet.
