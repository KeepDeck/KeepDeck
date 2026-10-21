# OpenCode

The integration was built for OpenCode 1.x. **OpenCode 2.x breaks it**, and
porting it is open work. Since 2026-10-21 the plugin LOADS on both: verified
live on 1.19.3 and 2.1.2. This document describes the 1.x integration and
then lists what 2.x changes.

## Per-spawn injection (1.x)

OpenCode has no command hooks. KeepDeck injects **one JS plugin** instead,
through `OPENCODE_CONFIG_CONTENT`: the directory `resources/keepdeck-plugin`,
by absolute path, under the `plugin` key. That array is additive, so
nothing is installed on the user's side.

- `index.js` is the entry. Its default export is `{ id, server, setup }`.
  OpenCode 1.x calls `server`, which starts both components below and
  merges their hooks. OpenCode 2.x calls `setup`, which does nothing yet.
  A component that fails to start, or a handler that throws, takes nothing
  else down.
- The two components are one entry, not two plugins, because they share
  `pane-session.js` and one wire (`keepdeck-bridge.js`). OpenCode 2.x gives
  each plugin entry its own copy of a sibling module.
- `session-reporter.js` reports identity, usage and turn lifecycle to the
  deck.
- `mail-courier.js` asks the deck for mail and puts it into the session
  through the plugin's own server client (`promptAsync`). Standing context
  goes in with `noReply`, so it does not open a turn.
- `pane-session.js` is shared by both. It owns which session is the pane's
  root, and the ancestry used to tell a subagent's session from the main
  one.
- MCP servers travel in the same `OPENCODE_CONFIG_CONTENT`.
- Skills come through `OPENCODE_CONFIG_DIR` as an env default.
  `src/warm.ts` makes sure that directory's dependencies are installed.
- `KEEPDECK_OPENCODE_SKIPS_APPROVALS` is set for permission-skipping panes.
- Remote panes use `opencode attach <endpoint>`.

`stageLaunch` in `src/index.ts` is what every launch carries, through the
shared `launchPlans`.

## Mail (1.x)

The courier asks at four moments: `session.created` (the brief),
`chat.message` (the user is sending anyway), `session.idle` (turn end), and
a wake from the deck. There is no tool-boundary moment, so mail for a
working OpenCode pane waits for the turn to end.

When ancestry cannot be determined, a session is classified "unknown", and
the courier adopts it as the root, so the pane is never unreachable. Each
ask reports its delivery target (`root`, `child` or `unknown`), fixed before
the ask. The deck hands mail only to `root`, so an unclassified root waits.

## Status (1.x)

Bus events from the reporter: `session.status` (busy or idle),
`session.idle` and `session.error`, plus permission and question dialogs. A
dialog raised by a child session blocks the pane too.

## Sessions and fork (1.x)

Sessions are in OpenCode's SQLite database, read-only. Fork into another
directory goes `opencode export`, then re-key every id and set the
directory (`src/rekey.ts`), then `opencode import` run from the target
directory. `import` records the directory from its cwd, not from the JSON.
If that fails, KeepDeck falls back to native `-s <id> --fork`, which stays
in the source directory.

## What OpenCode 2.x changes

Read from the 2.0.32 and 2.1.2 source, and verified live on 2.1.2
(2026-10-21) where marked. Each item is a task in the OpenCode 2.x epic.

- **Plugins.** A plugin must export `{id, setup}` or `{id, effect}`.
  A plugin given as a FILE path is dropped; a directory is required
  (live). The legacy `plugin` key still works. KeepDeck's plugin now has
  this shape, so it loads on 2.x, but `setup` does nothing yet.
- **Config dir.** `OPENCODE_CONFIG_DIR` REPLACES the user's global config
  on 2.x instead of adding to it (live), so it must not be set there.
- **Database.** 2.x adds `session_v2` tables to the same `opencode.db`
  and imports 1.x sessions ONCE. A session made on 1.x afterwards is
  never imported (live), so history must read both.
- **Server.** One shared background server unless `--standalone` is given,
  so per-pane env and plugins need `--standalone`.
- **Remote.** `attach` is gone; it is now `--server <url>` with
  `OPENCODE_PASSWORD`.
- **Fork.** `--fork` is gone; forking needs the API's fork plus a move.
- **Status.** Events are new (`session.execution.*`, `permission.*`,
  `form.*`).
- **Skills.** There is a `skills` config key, which can replace
  `OPENCODE_CONFIG_DIR`.
- **Session id.** `-s <id>` creates the session if it is missing, so
  KeepDeck can choose the id at spawn.
- **Mail.** A session inbox over HTTP with `steer` and `queue` modes would
  let mail land mid-turn without touching the input box.
