# Mail delivery

Checked 2026-10-19 against Claude Code 2.1.302, Codex 0.163.0, Kimi Code
2.2.0 and OpenCode 2.0.

A KeepDeck team sends messages between agents (`mail.send`). This document
explains how such a message gets into an agent's context, and when.

## The agent pulls, the deck does not push

A message is never typed into an agent's terminal. The agent collects its
own mail from a hook: a short reporter script that runs at a hook event,
asks the deck what is waiting (`--ask`), and returns the messages in the
CLI's hook-output format. The plugin's mail renderer decides that format.

Mail arrives framed as `<teammate-message>`, with a sentence saying it is
another agent's output and not the user's instruction. A terminal paste
could not say that: it is indistinguishable from what the person typed.

## Delivery windows

An agent can collect mail at these moments:

| Window | When | Claude | Codex | Kimi | OpenCode |
|---|---|---|---|---|---|
| Session start | the session begins, or its context was compacted | `SessionStart` | `SessionStart` | none | `session.created` |
| Turn start | a prompt opens a turn | `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` |
| Tool boundary | between tool calls, inside a turn | `PostToolBatch` | `PostToolUse` | none | none |
| Turn end | the agent is about to stop | `Stop` | `Stop` | none | `session.idle` |

Each plugin declares these as its mail channels
(`AgentStatus.mail.channels`), and the declaration is the one list: it
decides where the reporter is armed with `--ask` and whether the deck can
hold mail for a working pane.

The tool-boundary window is what makes mail arrive in the middle of work.
Claude and Codex have it, Kimi and OpenCode do not, so on those two a
message waits for the end of the turn.

- Kimi only reads hook output from `UserPromptSubmit`, `Stop` and
  `PreToolUse`. `PreToolUse` can only veto the tool, and `PostToolUse` is
  fire-and-forget. Kimi 2.2 has no way to add context mid-turn.
- OpenCode 2.0 has a session inbox with a `steer` mode that puts a message
  into the running turn programmatically. Moving the courier to it is
  planned work.

## Holding and waking

The policy lives in `src/domain/mail/policy.ts` (`decideDelivery`).

- **The pane is working and its agent declares a turn-end channel:** the
  deck holds the message. A boundary is coming, and the agent will collect
  it itself.
- **The pane is working and its agent has no turn-end channel** (Kimi):
  the deck wakes it once. The nudge queues behind the running turn and opens
  the next one, whose turn-start hook collects the message.
- **The pane is idle:** the deck wakes it. It types a short nudge that
  makes the agent take a turn, and that turn's own hook collects the mail.
  The nudge carries no content. An agent with an in-process reporter is
  woken through it instead: the deck rings a doorbell file and the reporter
  starts the turn from inside — opencode always, claude while its Mod is
  present (`wake: "companion"`).
- **The pane waits on a permission prompt:** the deck holds.
- **Standing context (the team brief):** never nudged. It waits for the
  next window that asks.

The brief is queued again whenever the agent may have lost it: a new
session, or a compaction. Claude and Codex report a compaction from the
same `SessionStart` (source `compact`) that asks for mail, and the deck
queues the brief while reading that report, before answering it. So the
brief is back in front of the model on the request right after the
compaction.

The deck once also nudged panes that were already working. That was
removed. The keystrokes land in the CLI's input box, behind whatever the
person is typing, and submit the half-written text with them. The agent
collects at its next boundary anyway, so the nudge bought nothing.

## Steering

Several CLIs can take input into a running turn ("steering"). It matters
for status rather than for mail: a steered prompt is not a new turn and
must not restart the pane's "working since".

- **Codex.** Input typed during a turn becomes pending input of that turn,
  and `UserPromptSubmit` runs on it. The payload has no steer flag, but
  `turn_id` is the running turn's id. Source-read.
- **Claude Code.** Input typed during a turn is folded into it at the next
  tool batch (`queued_command`, absorbed mid-turn). No steer flag was found
  in the hook payload. Read from the binary, not verified live.
- **Kimi.** Plain Enter queues the input for the next turn; Ctrl+S steers it
  into the running one. The `UserPromptSubmit` payload has an `is_steer`
  field, but 2.2.0 always sends `false`.
- **OpenCode.** The sender chooses `steer` or `queue` on the session inbox,
  so for inbox mail KeepDeck decides.

## Only the main agent receives mail

A hook can fire for a subagent as well as for the pane's main agent. Mail
handed to a subagent never reaches the main agent, and the deck's queue
counts it as delivered.

Each plugin attributes every report (`AgentStatus.attribute`): who raised
it (main, child or unknown), and whether it may move the pane's status.
plugin-api's `agentEvents` holds the one rule that follows:

- `admitMail` hands mail out only on a declared channel, raised by the
  main agent, in a payload that arrived whole. It is asked before anything
  leaves the queue, and a refused ask gets an empty answer.
- `admittedNormalizer` runs the plugin's normalizer only for reports that
  may move the pane.

Per CLI:

- **Codex.** Subagent hooks carry `agent_id` and `agent_type`; the main
  agent's carry neither, and `session_id` is shared. A subagent fires
  `SubagentStop`, not `Stop`, but its `UserPromptSubmit` and `PostToolUse`
  reach the reporter (verified live on 0.163.0). They move nothing and
  take no mail.
- **Kimi.** `UserPromptSubmit` runs only for the user's prompts, so it is
  the main agent's, and it is Kimi's only channel. `Stop` fires for
  subagents with no agent identity, so it does not ask.
- **Claude Code.** Subagent hook events carry `agent_id`. They still move
  the pane (a subagent's tool use clears an approval wait nobody can tag),
  but they take no mail.
- **OpenCode.** The courier fixes its delivery target before asking and
  reports whether it is the pane's root. A root adopted while the client
  could not classify it names nobody, so mail waits.

Payloads larger than about 255 KB are cut down by the reporter to the event
name alone, which also drops `agent_id`. The reporter marks them
`reduced: true`, does not ask for mail on them, and the deck never hands
mail out on one.
