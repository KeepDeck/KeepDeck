# keepdeck-lifecycle

The lifecycle of KeepDeck's workspaces, teams and panes — creating them,
seating agents, continuing conversations, closing, archiving — as pure rules
written on `keepdeck-fsm` (`crates/keepdeck-fsm`). One machine with one
queue: every intent, every result of work and every timer goes through it one
at a time, so the rules need no locks.

Its layers are two modules. `domain` holds the rules and is pure: no I/O, no
clock, no threads, nothing from `infrastructure`. `infrastructure` holds the
journal's file and format and the port of its store. The crate does no I/O
itself: the app (`src-tauri/src/lifecycle`) runs the machine on
`keepdeck-fsm-runtime`, and its handler is the only one that touches git, the
journal on disk, plantings and the stores. Processes are stopped by the
sessions machine, a feature of its own.

## What lives here

| Module | Owns |
|---|---|
| `domain::ids` | The names the lifecycle gives: workspace and team tokens drawn by the door; pane, operation, permit and attempt counters that only grow within a launch; the exact id of a command |
| `domain::dir` | A directory's key — trailing slashes and surrounding space make no other folder |
| `domain::model` | The closed set of intents, how each meets another (exclusive, additive, gated), which keep a journal entry, the consent a Close carries, the refusals and the answer, and the strategy of each teardown |
| `domain::command` | The commands to the data owners that stay in TS — deck, boards, mail, launch state, notices, the fork step — and their answers |
| `domain::journal` | What the entry of an unfinished operation holds |
| `domain::places` | A team's place — `kd-<ws>-N`, `kd/<ws>/N` — and the first one nobody holds |
| `domain::world` | The living part of the deck as the machine keeps it: workspaces, teams and where they run, panes |
| `domain::machine` | The machine itself — `State`, `Event`, `Effect`, `update`, `work` — and the snapshot TS reads |
| `infrastructure::journal` | An entry's file and format, the port of its store, and how boot reads the files back |

## The machine

`update` applies an event, then lets every operation go as far as the state
now allows: a step waits on facts — an entry on disk, a deck command
durable, the last session of a team ended — never on which event made them
true. Inside, by module:

| `domain::machine::…` | Owns |
|---|---|
| `capture` | Who goes first: exclusive operations hold a pane, a team, a workspace or a folder; additive ones go one after another; a Close takes over a creation and an archive, a workspace close joins a disband |
| `launch` | Permits for one owner and one target, spent by one admission; the sessions the sessions machine reports; a late session of something forgotten is stopped |
| `teardown` | The one core of every teardown: queued behind the additive operations begun before it, journaled with its final membership, «forgotten» and «retire», rows and stops, the start boundary, the plan read before the first removal, the steps, the debt |
| `create` | Workspaces, teams with their places and tickets, seats, resumes, relocations, and the fork — finished only once its launch is bound, rolled back whole otherwise |
| `boot` | The barrier, the handshake with its five load states, the operations the journal left, the reconciliation |
| `snapshot` | What TS sees: phases, each team's gates, «forgotten», the commands owed |

## The journal

One JSON file per operation, `op-N.json`, in `~/.config/keepdeck/lifecycle/`.
Only operations with a step that cannot be taken back keep one; it is on disk
before that step, and removed once every step is done and the operation's last
deck command is saved. In normal running the folder is empty.

An entry is self-sufficient: the tail of its operation needs nothing else. It
names no sessions — session ids start again with each launch.

A file boot cannot read — corrupt, written by a newer build, misnamed — is
never replayed and never kept: boot hands it back with its content, cut to a
bound, for the log, and removes it. What it would have removed stays held
by the place rules, as anything on disk does.

## Tests

```sh
cargo test -p keepdeck-lifecycle
```
