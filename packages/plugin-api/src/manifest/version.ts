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
export const API_VERSION = 38; // 38: + FsReadFileOptions.offset (a read may start anywhere in the file, which turns `maxBytes` from a ceiling on the whole read into the size of ONE WINDOW — a large store is walked window by window instead of materialized); 37: + the mail surface an agent's plugin needs to carry teammate messages — AgentStatus.renderMail (turn waiting mail into what this CLI's hook must print), AgentStatus.wake ("terminal" | "bridge": how the deck nudges this pane into a turn), DeliverableMail (with `standing`, the host's answer to context-vs-traffic so no plugin re-derives it), MailReplyInput (with cliVersion, the CLI's own `--version`, so a renderer can speak the hook-output schema its RELEASE accepts), MailReplyRenderer, and frameTeammateMail (the one wording of the promise that these are another agent's words); 36: + AgentStatusEvent "context-compacted" (the CLI rebuilt its context; a recorded failure is no longer current); 35: + AgentStatusEvent "agent-turn-start"/"agent-turn-end"/"agent-turns-cleared" (a turn running alongside the main thread — subagents, teammates); 34: + AgentStatusEvent "parked" (a turn the CLI closed while work it started keeps running); 33: commands drop `destructive` (its only consumer was an MCP tool annotation whose effect was the client's); 32: + injected MCP servers (SpawnPlanInput.mcp); 31: + AgentContribution.status (turn-lifecycle edges: AgentStatus/StatusNormalizer/AgentStatusEvent); 30: static CLI agent `features` become the single functional-support declaration; 29: UsageTailFormat adds Claude transcript usage; 28: agents contribution summary gains an optional static `bin` (pre-activation availability); 27: + AgentContribution.remote + SpawnPlanInput.target (remote targets — a pane's agent runs against a remote nativeServer endpoint); 26: + clipboard service (PluginClipboard) with clipboardWrite/clipboardRead capabilities; 25: usage capabilities split into paneTelemetry/accountLimits; PaneUsage sequence; 24: + fork.plan hook, fsWrite + sqliteReadonly capabilities (PluginFsWrite/PluginSqlite services), AgentContribution.history discovery, FsEntry.mtime; 23: + env defaults (SpawnPlanOutput.envDefaults); 22: + staged shared skills (SpawnPlanInput.skills)

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
