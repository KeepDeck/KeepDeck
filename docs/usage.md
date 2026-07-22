# Usage telemetry and statistics

KeepDeck treats two similarly named capabilities as different products:

- `paneTelemetry` is usage of one agent session: context occupancy, cumulative
  tokens, model and cost.
- `accountLimits` is a provider-account allowance or rolling limit window.

An agent declares either capability explicitly. The top-bar chips and their
popover consume only `accountLimits`; session tokens and cost live in the
separate top-bar **Usage statistics** screen. It is global rather than a
Settings section or workspace dock because its ledger spans every CLI and
workspace. The same screen is reachable from the account-limits popover and
the `usage.open` command. This is why OpenCode can report useful usage without
appearing as an empty account-limit chip.

## Agent sources

| Agent | Pane telemetry | Account limits |
| --- | --- | --- |
| Claude Code | documented status-line JSON | `rate_limits` in the same status line |
| Codex | tailed rollout `token_count` / `turn_context` events | official app-server `account/rateLimits/read` |
| Kimi Code | tailed session `wire.jsonl` usage records | usages endpoint used by Kimi's own `/usage` |
| OpenCode | injected per-spawn plugin, using SDK session/message events | not available |

The OpenCode reporter is loaded per spawned process through merged config; it
does not install or modify a user's global OpenCode setup. Completed assistant
messages are keyed by session + message id, so repeat updates replace instead
of double-counting. A root session owns one generation:

- `/new` clears the in-process generation and resets its sequence;
- resume hydrates the root plus descendant session histories through the SDK;
- child/subagent spend rolls up to the root, but only root messages define the
  pane's current context/model;
- OpenCode keeps provider + model as an internal catalog key because model ids
  are not globally unique, but the shared telemetry schema groups by CLI agent
  and model instead of exposing a provider field other adapters cannot fill;
- event callbacks run through a promise queue because OpenCode does not await
  plugin event handlers.

OpenCode supplies per-message token/cost facts and model context limits. It does
not expose an account rate-limit window, so KeepDeck deliberately makes no such
claim.

## Host lifecycle

Bridge reports must match both the live pane membership and the secret minted
for that spawn. Session changes replace rather than merge telemetry; a lower
reporter sequence for the same session is ignored. Closing or manually
restarting a pane clears its live telemetry and revokes the old spawn token, so
a late filesystem event cannot repopulate it.

## Durable Stats ledger

Live plugin reports are cumulative snapshots, but `usage-history.jsonl` stores
canonical non-negative deltas. Every event also carries the observed cumulative
counters; after an application restart, a replayed session rebuilds its
baseline without counting the same usage twice.

Writes are append-only and fsynced. Loading is tolerant per line, deduplicates
event ids and atomically compacts old data. Analytics retains 90 days; at most
one older checkpoint per session remains on disk solely to preserve the replay
baseline. Records include agent/model, workspace, pane, root session,
worktree metadata, token buckets, cost provenance and pricing version.

Provider-reported cost always wins. When cost is absent, KeepDeck currently
estimates only exact recognized Codex/OpenAI model ids using the immutable
`openai-standard-2026-07-22` table. Estimated values are API-equivalent and are
shown with `≈`; they are not subscription charges. Unknown models and
subscription-only Kimi Code sessions show no fabricated zero or price.

The table was based on the official [OpenAI model catalog](https://developers.openai.com/api/docs/models)
and exact model pages such as [GPT-5.3-Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex).
Changing rates requires a new pricing-version string; historical events keep
the version used when they were recorded.
