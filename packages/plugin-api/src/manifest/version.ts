/**
 * The plugin API's own revision — a plain incrementing INTEGER, not semver. It
 * moves by exactly one whenever the contract grows (a new service, a new
 * capability); a plugin's `minApiVersion` is the lowest revision it needs. A
 * single number is all a contract floor is: there is no meaningful major/minor
 * split for "the API got bigger." (Was `major.minor.patch` `0.0.N`; this is N.)
 *
 * Independent of the app version, and independent of `@keepdeck/plugin-api`'s
 * package.json version (that one is just an npm semver so the workspace
 * resolves the package). This is the load-bearing one.
 *
 * WHAT DOES NOT MOVE IT: the host getting STRICTER about something the
 * contract already required. The manifest gate has always thrown for an
 * undeclared contribution without a revision behind it, and the number is a
 * floor for what a plugin may CALL, not a record of how forgiving the host was
 * on any given day. Such changes are recorded here in prose instead, so an
 * author reading a new refusal finds out why:
 *
 *   under 37 — a contributed action's `title` must be non-empty (it is the
 *     button's only name, and a blank one drew a control nobody could read or
 *     describe), a long one is trimmed to a label's length, and one id may
 *     hold only one LIVE registration at a time (two would collide in the
 *     chrome's own keys). All three are refusals at registration: the plugin
 *     lands `failed` and the message names the contribution.
 */
export const API_VERSION = 44; // 44: the last thing in the host that named an agent is gone. `UsageTail.format` — the dialect name kept alive one version longer for the two jobs that were not parsing — is deleted, and both jobs went home with it. The `agent` a report rides under is passed at ARMING by the side that knows which pane belongs to which plugin, instead of being derived from a format enum. `UsageTail.siblings(store)` names a directory of files contributing to the same session (claude's `<transcript>/subagents/*.jsonl`), so the rule turning one path into the other stops living in the host — where it cost a pane of every OTHER agent a directory read per poll. `UsageTail.sweep()` names the stores worth reading cold at startup, replacing a host command that walked one particular CLI's day-partitioned tree looking for one particular record kind; the host reads the candidates in order until a normalizer makes an account claim, which is the part that was always its own. The TUI-resume fallback stops being gated to one agent by name and asks whichever dialect can be asked. Nothing under session_tail names claude, codex or kimi any more; 43: AgentUsage.tail stops being a DIALECT NAME ("claude" | "codex" | "kimi-wire") and becomes a UsageTail — the watches carrying this agent's numbers, in the same descriptor the status lane already used. The host held one parse arm per name (which lines carry counts, what to trim them to, how to add them up); all three are gone, and with them the last place three CLIs' formats lived in the side meant to know none of them. TailWatch gains `sum`: a TailSum of named buckets, an optional `dedupBy` for a store that writes one message as several rows, and the key to stamp the running total under. The arithmetic stays where the bytes are and cannot move — a store is drained once at arming and only the LAST record of each watch survives, so a large transcript's twelve thousand counted rows would be eight megabytes across the boundary per pane — but what it adds, and whether repeated rows are one message, is now DECLARED. Watch declaration order is the catch-up order (the window before the counts it qualifies), and a status-lane record never survives a replay. Normalizers read `carriedUsageRecord(payload)`, and CARRIED_RECORD is one exported name rather than a literal agreed in four places; 42: + SessionTailDialect and tailPass — the live sibling of SessionDialect, so a plugin says what a record of its OWN store means while that store is still being written, instead of the host reading a claude transcript for `interruptedMessageId` and deciding for it. Three members and each answers something only the plugin can: `follow` (which store, because topology is the agent's shape and a host that knew it would be a host that names agents), `read` (the record's meaning, returned as the host's CLOSED status union so a dialect cannot report what the deck has no meaning for, nor put a session's contents on the bus — there is no field for them), and `ignores` (whether a record it said nothing about is one it KNOWS, which is the only thing separating ordinary traffic from a format that moved underneath us). Nothing calls it yet; the agents move over one at a time next, each against a bench proving its output did not change; 41: PluginSqlite.query answers a SqlAnswer (rows + `stopped` + payloadBytes) instead of a bare row array, and Shortfall gains { kind: "rows", returned } — a query result is bounded in BYTES by the host, which is the only side that can see how big a row is, and a plugin that used to guess with a LIMIT now reads how far it got; 40: + ReadScope on the session store and the walk ("whole" | "head") — a caller states how far it MEANS to read and the host supplies the distance, because "my facts are at the store's start" is a true claim about one agent's format and false about another's, while how far the start reaches is the app's memory to decide; a head reading reports no shortfall, having never meant to read the conversation; 39: + the session-store reader — services.sessionStore (PluginSessionStore.read over a typed SessionFormat descriptor, an opaque SessionCursor, and a ReadOutcome that names the REASON a read stopped), the `jsonl` transport, and walkSession/SessionDialect above it, so a plugin says what one record of its own format MEANS and holds no sizes at all; 38: + FsReadFileOptions.offset (a read may start anywhere in the file, which turns `maxBytes` from a ceiling on the whole read into the size of ONE WINDOW — a large store is walked window by window instead of materialized); 37: + the mail surface an agent's plugin needs to carry teammate messages — AgentStatus.renderMail (turn waiting mail into what this CLI's hook must print), AgentStatus.wake ("terminal" | "bridge": how the deck nudges this pane into a turn), DeliverableMail (with `standing`, the host's answer to context-vs-traffic so no plugin re-derives it), MailReplyInput (with cliVersion, the CLI's own `--version`, so a renderer can speak the hook-output schema its RELEASE accepts), MailReplyRenderer, and frameTeammateMail (the one wording of the promise that these are another agent's words); 36: + AgentStatusEvent "context-compacted" (the CLI rebuilt its context; a recorded failure is no longer current); 35: + AgentStatusEvent "agent-turn-start"/"agent-turn-end"/"agent-turns-cleared" (a turn running alongside the main thread — subagents, teammates); 34: + AgentStatusEvent "parked" (a turn the CLI closed while work it started keeps running); 33: commands drop `destructive` (its only consumer was an MCP tool annotation whose effect was the client's); 32: + injected MCP servers (SpawnPlanInput.mcp); 31: + AgentContribution.status (turn-lifecycle edges: AgentStatus/StatusNormalizer/AgentStatusEvent); 30: static CLI agent `features` become the single functional-support declaration; 29: UsageTailFormat adds Claude transcript usage; 28: agents contribution summary gains an optional static `bin` (pre-activation availability); 27: + AgentContribution.remote + SpawnPlanInput.target (remote targets — a pane's agent runs against a remote nativeServer endpoint); 26: + clipboard service (PluginClipboard) with clipboardWrite/clipboardRead capabilities; 25: usage capabilities split into paneTelemetry/accountLimits; PaneUsage sequence; 24: + fork.plan hook, fsWrite + sqliteReadonly capabilities (PluginFsWrite/PluginSqlite services), AgentContribution.history discovery, FsEntry.mtime; 23: + env defaults (SpawnPlanOutput.envDefaults); 22: + staged shared skills (SpawnPlanInput.skills)

/** Oldest contract the current host can execute. Raise only for a breaking change. */
export const MIN_COMPATIBLE_API_VERSION = 21;

/**
 * Whether a manifest's floor falls inside the host's compatibility window.
 * Fails CLOSED — any non-integer (a malformed manifest, a stray `0.0.x` string
 * that slipped the reader) yields `false`, so it can never pass the gate.
 */
export function satisfiesApiFloor(
  minApiVersion: number,
  apiVersion: number = API_VERSION,
  minCompatibleVersion: number = MIN_COMPATIBLE_API_VERSION,
): boolean {
  if (
    !isApiVersion(minApiVersion) ||
    !isApiVersion(apiVersion) ||
    !isApiVersion(minCompatibleVersion)
  ) {
    return false;
  }
  return minApiVersion >= minCompatibleVersion && minApiVersion <= apiVersion;
}

/** A valid API revision: a non-negative integer. */
export function isApiVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `major.minor.patch`, all numeric — the plugin's OWN version (display and
 * update bookkeeping), which stays semver; anything else is not a version. Not
 * used for the API floor (that's an integer, see `API_VERSION`). */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
