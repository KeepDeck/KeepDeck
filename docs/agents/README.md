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

Shared cores in `packages/plugin-api` so far:

- `agentEvents`: whose report an event is, what it may move, and who gets
  mail (see [mail-delivery.md](mail-delivery.md)).
- `sessionHistory`: the history contract. It decides what an unreadable or
  partly readable store means to the strict `list` and the partial
  `listing`, and how transcript pages are read. A plugin supplies only a
  `SessionStore`: how to enumerate, describe and read its own sessions.
- `keepdeck-wire.js` (`resources/reporters/`): the bridge wire for
  reporters that run inside an agent (opencode's plugins, claude's Mod) —
  envelope, ask, ordered publishing — with the environment and the POST
  supplied by each adapter. Copied beside each adapter by
  `scripts/sync-reporters.mjs`; a test fails while a copy is stale.
- Report origin: every process under a pane inherits its secret — in
  `KEEPDECK_BRIDGE`, and in the MCP config a spawn injects — and keeps it
  after it detaches. So a sender counts for a pane only when its process
  belongs to the pane now: it is one of the pane's OWN processes, or its
  direct parent is (`PtySession::hosts`, asked through
  `SessionRegistry::pane_of`). The pane's own processes are those in its
  terminal's session, plus the process its reports are pinned to (the
  binding ledger, `src/app/paneAttribution.ts`, handed down by
  `session_vouch`) while that process itself still belongs to the
  terminal. The parent clause admits agents that start their own helpers
  detached: kimi's MCP servers, and opencode 2.x's, which are children of
  the `serve` its agent runs in. Being admitted through a parent does not
  extend to one's own children, so a daemon's workers have no own parent
  in any pane (task-376, verified live 2026-10-22). The bridge answers 403 to an envelope whose named
  reporter fails this (`src-tauri/src/bridge/origin.rs`); the MCP socket
  takes the client's pid from the socket, and the webview counts its secret
  only from that pane (`src/app/mcp/paneIdentity.ts`), else the connection
  is anonymous. This keeps a daemon an agent started from one pane from
  acting as a pane forever (claude's background workers did, task-422 and
  task-424).
- Companions: a reporter inside the agent announces itself once
  (`companion.hello`); `AgentContribution.companion` declares what that
  takes over for the announcing process, and `wake: "companion"` rings it
  instead of typing. One source per process, never two.
- Unbinding: a reporter whose agent left its conversation for none at all
  (opencode's `/new` before the first prompt) sends `session.unbound`.
  It is verified like any pane report (`src/app/paneUnbinding.ts`). The
  deck then forgets the pane's session, so a restore starts fresh, and
  ends its telemetry (`PaneLifecycle.endSession`). Claude's `/clear`
  mints its next id at once and never needs it.
- `launchPlans`: the spawn, resume and fork hooks. A plugin supplies a
  `LaunchAdapter`: what every launch carries (`stage`, which may settle the
  launch whole, as a remote attach does), and how resume and fork name the
  session. A resume may also name it in the environment, for a CLI whose
  reporter cannot read the arguments (opencode 2.x). A fork may also return a `discard`: the scaffolding its surgery
  made that only the start needs. The host removes it, through the
  plugin's own `fsWrite` prefixes, once the forked session reports its id,
  and removes everything listed in `ifNeverStarted` when the pane goes
  first.
- The fork's source transcript path is the host's to give: from the
  binding report, else from the session index, which walks the agent's
  store again on a miss. A plugin never derives it.

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
- [claude-code.md](claude-code.md): Claude Code.
- [codex.md](codex.md): Codex.
- [kimi.md](kimi.md): Kimi Code.
- [opencode.md](opencode.md): OpenCode, the 1.x integration and what 2.0
  changes.
