# keepdeck-lifecycle

The lifecycle of KeepDeck's workspaces, teams and panes — creating them,
seating agents, continuing conversations, closing, archiving — as pure rules
written on `keepdeck-fsm` (`crates/keepdeck-fsm`). One machine for the whole
feature, with one queue: every intent, every result of work and every timer
goes through it one at a time, so the rules need no locks.

This crate does no I/O. The app (`src-tauri/src/lifecycle`) runs the machine on
`keepdeck-fsm-runtime`, and its handler is the only one that touches git, the
journal on disk, plantings and the stores. Processes are stopped by the
sessions machine, a feature of its own.

## What lives here

| Module | Owns |
|---|---|
| `ids` | The names the lifecycle gives: workspace and team tokens drawn by the door; pane, operation, permit and attempt counters that only grow within a launch; the exact id of a command |
| `dir` | A directory's key — trailing slashes and surrounding space make no other folder |
| `model` | The closed set of intents, how each meets another (exclusive, additive, gated), which keep a journal entry, the consent a Close carries, the refusals and the answer, and the strategy of each teardown |
| `command` | The commands to the data owners that stay in TS — deck, boards, mail, launch state, notices, the fork step — and their answers |
| `journal` | The entry of an unfinished operation, its codec and the port of its store, and how boot reads it |

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
