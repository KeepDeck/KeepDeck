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
  merges their hooks. OpenCode 2.x calls `setup` (`opencode-v2.js`).
  A component that fails to start, or a handler that throws, takes nothing
  else down.
- The two components are one entry, not two plugins, because they share
  `pane-session.js` and one wire (`keepdeck-bridge.js`). OpenCode 2.x gives
  each plugin entry its own copy of a sibling module.
- `session-reporter.js` reports identity, usage and turn lifecycle to the
  deck.
- `mail-courier.js` asks the deck for mail and puts it into the session
  through the plugin's own server client (`promptAsync`). Standing context
  goes in with `noReply`, so it does not open a turn. Both calls repeat the
  agent, model and variant of the newest message the user sent in that
  session (`prompt-selection.js`). Without them opencode switches to the
  default agent and drops the variant, and a `noReply` call does too. A
  message counts as the user's when it has a text part that is neither
  synthetic nor KeepDeck's mail frame. Limits: it is the last prompt the
  user SENT (a model picked in the composer and not yet used is invisible),
  and a files-only message is passed over.
- `pane-session.js` is shared by both. It owns which session is the pane's
  root, and the ancestry used to tell a subagent's session from the main
  one.
- MCP servers travel in the same `OPENCODE_CONFIG_CONTENT`.
- Skills come through `OPENCODE_CONFIG_DIR` as an env default on 1.x;
  `src/warm.ts` makes sure that directory's dependencies are installed.
  On 2.x they come as `skills: [<staged skills dir>]` in
  `OPENCODE_CONFIG_CONTENT` instead, with no config dir and no warming.
- `KEEPDECK_OPENCODE_SKIPS_APPROVALS` is set for permission-skipping panes.
- Remote panes use `opencode attach <endpoint>`.

`stageLaunch` in `src/launch.ts` is what every launch carries, through the
shared `launchPlans`. A launch is one interface, `OpencodeLaunch`, with a
whole launch per case composed from parts:
- shared parts: KeepDeck's plugin, MCP servers, the permission mode;
- 1.x: the staged config dir (skills, warm-up) and its flags;
- 2.x: the `skills` config key and `--standalone`;
- remote: `attach <endpoint>` and nothing local.

`launchFor` is the only place that reads the version and the target. An
unknown version runs as 1.x. The draft a launch fills holds only what every
launch carries.

## Which session is on screen (1.x)

`/new` and `/sessions` move only the TUI's own route; the server, and so
KeepDeck's server plugin, hears nothing. Mail used to go into the session
the user had left, and the agent worked there unseen (task-435).

- `route-observer.js` is a TUI plugin, loaded through `tui-v1.json` beside it.
  A local 1.x launch points `OPENCODE_TUI_CONFIG` at that file, as an env
  DEFAULT, apart from the skills' config dir. It polls `api.route.current`
  every 250 ms and hands it to `observeRoute` in `foreground.js`, which
  writes `foreground.json` into the pane's bridge directory: a route that
  held for two polls, plus a heartbeat every second.
- `foreground.js` reads it: `unknown` (no observer for the TUI this process
  serves, or silent for 30 s, so behave as before), `stale` (silent for 3 s),
  `home`, `other`, or `session`. A record is trusted only from the TUI's pid,
  which the follower is started with (`follower().start(dir, tui)`); the
  courier reads the screen through `follower().screen()`.
- `follower.js`: when another session is on screen, the pane moves to it
  (to its root for a subagent's view; not at all if it cannot be
  classified). The move is one job in the reporter's queue: `session.bound`
  with source `resume`, then the session's spend. After the wire has drained,
  the courier collects for it.
- Leaving a conversation stops it (user decision; `leaving.js`, which the
  1.x reporter hands its abort as `interrupt`): another root on screen,
  or the home screen after a session this process showed. The reporter
  aborts the left session's turn, outside its own queue. A move to another
  session needs nothing more. For the home screen, the abort's error and
  idle reach the deck as the pane's. Then `pane-session.js` `detach()` keeps
  the left session (`left`) so neither it nor its subagents can rebind the
  pane, and `session.unbound` makes the deck forget the session. A restore
  starts fresh (`src/app/paneUnbinding.ts`). With no ending within 3 s it
  lets go anyway, unless the pane already moved on. opencode STARTING on
  home (before `-s` opens, or the native `--fork`) is not a leaving.
- Mail goes only where the user is looking. Every channel asks the same
  rule, in `courier-policy.js` (the 1.x courier supplies how to create,
  show and deliver into a session): `unknown` behaves as before; the pane's root or its subagent's view
  is delivered to; anything else is held, the end-of-turn ask and
  `mail.ask.tool` alike. The courier never moves the pane.
- On the home screen after a leaving, only a doorbell ring (mail waiting)
  makes a session: create, check it is still home, `tui.session.select`,
  wait until the screen shows it and the pane is bound (≤3 s), drain, and
  only then ask. Brief and mail arrive together, with the selection of the
  conversation left. No ack means no ask and no retry until the screen
  changes. A root session the courier did not make is the user's own, and
  the path stops.

## Mail (1.x)

The courier asks at five moments: `session.created` (the brief),
`chat.message` (the user is sending anyway), `tool.execute.after` (a tool
call returned mid-turn), `session.idle` (turn end), and a wake from the
deck. Verified from the 1.19.3 source, 2026-10-22.

- Two channels: `mail.ask` runs at a turn's edges and counts as turn end;
  `mail.ask.tool` runs after each tool call. The deck holds mail for a
  working pane rather than wake it, and `mail.ask.tool` is the boundary it
  waits for. The mail is appended to the tool's result, so the model reads
  it in the same turn. This is opencode's counterpart of claude's
  `PostToolBatch` and codex's `PostToolUse`.
- Until 2026-10-22 there was no tool-boundary channel, so mail for a
  working pane waited for the turn to end.
- Mail riding along with `chat.message` is added as complete parts, with
  `id`, `sessionID` and `messageID`. Since 1.16.0, a bare part fails the
  user's whole prompt.
- `src/app/mail/midTurnMail.test.ts` pins, per agent, how a working pane
  is reached.

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
  (live). The legacy `plugin` key still works. KeepDeck's `setup` is
  `opencode-v2.js`, the 2.x twin of the 1.x components, sharing the pane
  session, the wire, the mail ask and the doorbell with them. Read from
  the v2.1.2 source, 2026-10-22:
  - binding from `session.created`, or from a resumed pane's first session
    event;
  - turn events forwarded whole; the deck reads `session.execution.*` and
    `form.*`;
  - `usage.report` from `session.usage.updated` (running totals, subagents
    included), `session.step.ended` (context in use) and `model.list`
    (window);
  - mail through `session.synthetic` (the brief, no turn), `session.prompt`,
    `session.hook("prompt")` (riding along) and `tool.hook("execute.after")`
    (mid-turn). A pane with no conversation yet waits for its first turn.
- **Which session is on screen (task-436).** The 1.x rules, on 2.x's two
  processes. Measured on 2.1.2, 2026-10-24: the TUI spawns `opencode serve`
  as its child, so the server plugin's `process.ppid` is the TUI; `/new` is
  a new HOME TAB, and the session tab left behind runs its turn to the end.
  - `tui.js` is the 2.x TUI plugin (`{id, setup}`). 2.x loads a plugin
    directory's `tui` entry by itself, so the launch is unchanged; 1.x never
    loads it. It polls `ui.router.current()` (no change subscription) into
    the same `foreground.json`, and its `setup` returns the cleanup 2.x
    calls on reload.
  - `opencode-v2.js` starts the follower with the parent's pid, and returns
    a cleanup that stops the bus, the doorbell and the screen watch.
  - Leaving stops nothing on 2.x (user decision): `leaving.js` gets no
    `interrupt`, so on the home screen the pane lets go at once
    (`session.unbound`) and the tab runs on. Another session on screen moves
    the pane there (`session.bound`, source `resume`).
  - While the screen is known it alone decides: an unbound pane neither
    binds to nor forwards the events of a background tab.
  - Mail follows `courier-policy.js`, as on 1.x: only into the session on
    screen, and after `/new` a ring makes a session in the left one's agent
    and model. The 2.x server plugin cannot navigate, so the courier writes
    `show.json` (`show-request.js`) and `tui.js` shows it, only while the
    home screen is up.
- **Config dir.** `OPENCODE_CONFIG_DIR` REPLACES the user's global config
  on 2.x instead of adding to it (live), so KeepDeck does not set it there.
  Skills go through the `skills` config key, and 2.x lists them under its
  own `/skills`, so the per-skill palette commands 1.x needs are not made.
- **Database.** 2.x adds `session_v2` tables to the same `opencode.db`
  and imports 1.x sessions ONCE. A session made on 1.x afterwards is
  never imported (live), so history reads both (`src/history.ts`, rules
  in `src/historyMerge.ts`):
  - the shape (1.x, 2.x, both) is read from `sqlite_master` on every
    reading. `session_message` alone is not 2.x, 1.19.3 makes it empty;
  - an id 2.x has is read from 2.x, title, directory and archive
    included. A 1.x-only id is listed only if it was created after the
    import's `kv` marker `migration.v1-v2`: 2.x deletes leave the 1.x rows
    behind. While the import runs, every 1.x session stays and the listing
    is partial, so nothing is pruned;
  - the fingerprint is the newer clock of the two, plus the 1.x newest part
    time and the 2.x `event_sequence.seq`. The part time is read only for
    sessions 1.x touched after the import: reading it for all costs seven
    seconds on a real 10 GB store, the 2.x side about a millisecond;
  - a transcript is the 2.x messages, then the 1.x messages 2.x lacks. A
    1.x compaction summary is dropped when 2.x holds its compaction: the
    import folds it into that row;
  - limit: a 1.x rename or archive of an imported session does not show.
    1.x does not timestamp either.
- **Server.** One shared background server unless `--standalone` is given,
  so per-pane env and plugins need `--standalone`. KeepDeck now adds it
  when the CLI's `--version` names 2.x. Plugin API 62 hands the version to
  launch plans, asked anew for every launch, so a CLI swapped while the
  app runs is launched as what it now is. 1.19.3 exits on the flag, so an
  unknown version gets none.
  Verified live 2026-10-22:
  - 15 concurrent `--standalone` starts on an initialized db, no failure
    (upstream #53879 is a NEW db only);
  - the MCP server's parent is the `serve` process, in its own session, so
    the pane-identity rule of task-424 does not admit it yet (open).
- **Remote.** `attach` is gone; it is now `--server <url>` with
  `OPENCODE_PASSWORD`.
- **Fork.** `--fork` is gone; forking needs the API's fork plus a move.
- **Status.** Events are new (`session.execution.*`, `permission.*`,
  `form.*`).
- **Skills.** There is a `skills` config key, which can replace
  `OPENCODE_CONFIG_DIR`.
- **Session id.** `-s <id>` creates the session if it is missing, but
  only at the first prompt: the only check is the `ses` prefix (task-382,
  measured). A resumed 2.x pane gets its id twice. `-s` is for the TUI.
  `KEEPDECK_OPENCODE_SESSION` is for the plugin, which runs in the child
  `opencode serve` and never sees `-s`. The plugin binds the pane to it
  before anything starts (`opencode-v2.js`), so mail reaches a resumed pane
  at once instead of waiting for its first event. A fresh pane is not given
  an id yet: an early brief needs the plugin to create the session, and a
  later `/new` and prompt reuses a minted id (measured, task-436).
- **Mail.** A session inbox over HTTP with `steer` and `queue` modes would
  let mail land mid-turn without touching the input box.
