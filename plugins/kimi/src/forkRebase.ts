import { isJsonRecord } from "@keepdeck/plugin-api";

/**
 * What a cross-directory fork must change in a cloned kimi session, as pure
 * rules over the store's own records. `fork.ts` does the IO; this decides
 * what the copied bytes become.
 *
 * Kimi 2.2 checks a session against where it is opened, and it remembers
 * the old place in three places, each verified live on 2.2.0:
 *
 * - `state.json`: the directory (`workDir`, or `cwd` since 0.38), every
 *   agent's `homedir`, and — on version-2 metadata — the session's own
 *   `id`, which kimi trusts over the folder name. A clone that keeps the old
 *   id answers "Session not found" for the new one.
 * - every agent's `wire.jsonl`: `runtime.set_binding` names the workspace
 *   (`wd_…`) the agent runs in, and kimi asserts it against the session's on
 *   restore (`runtimeBindingService.ts`). The old one refuses to start.
 * - the MAIN agent's wire: the rendered system prompt — "The current working
 *   directory is …", the directory listing, AGENTS.md — saved once as
 *   `profile.bind` (or, by older kimis, `config.update` with a
 *   `systemPrompt`) and replayed verbatim on every resume. Kimi never
 *   re-renders it while one is saved.
 *
 * The prompt is not edited: its wording is kimi's and changes with kimi. It
 * is dropped instead, and kimi renders a fresh default profile for the new
 * directory when the main agent comes up without one. A fork is a new
 * session, so the profile, model and thinking the old one had chosen reset
 * with it. Subagents' prompts stay: kimi does not re-render a child's, and
 * resuming an old subagent inside a fork is not a case worth losing it for.
 */

/** Where the clone now lives. */
export interface ForkTarget {
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionDir: string;
}

/** The name the store's era gives the working directory. */
export type WorkDirKey = "workDir" | "cwd";

export interface RebasedState {
  readonly state: Record<string, unknown>;
  readonly workDirKey: WorkDirKey;
}

/** The clone's `state.json`, or null when the layout is not one we know —
 * no directory under either key, or no main agent home. */
export function rebaseState(
  state: Record<string, unknown>,
  target: ForkTarget,
): RebasedState | null {
  // The key the source used, never both: a clone carrying a field its own
  // era never wrote would lie about which era it is.
  const workDirKey: WorkDirKey | null =
    typeof state.workDir === "string"
      ? "workDir"
      : typeof state.cwd === "string"
        ? "cwd"
        : null;
  const agents = isJsonRecord(state.agents) ? state.agents : null;
  const main = agents && isJsonRecord(agents.main) ? agents.main : null;
  if (workDirKey === null || !agents || typeof main?.homedir !== "string") {
    return null;
  }

  const rebasedAgents = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      isJsonRecord(agent) && typeof agent.homedir === "string"
        ? { ...agent, homedir: `${target.sessionDir}/agents/${name}` }
        : agent,
    ]),
  );
  return {
    workDirKey,
    state: {
      ...state,
      [workDirKey]: target.cwd,
      // Only metadata that names itself carries an id; older eras take it
      // from the folder, which is already the new one.
      ...(typeof state.id === "string" ? { id: target.sessionId } : {}),
      agents: rebasedAgents,
    },
  };
}

/** The fields of a `config.update` that carry the rendered profile rather
 * than a setting. Kept, they would replay the old directory's prompt — and a
 * replayed `profileName` alone is what stops kimi rendering a fresh one. */
const RENDERED_PROFILE_FIELDS = [
  "profileName",
  "systemPrompt",
  "environmentDisclosure",
  "renderGeneration",
  "agentsMdPaths",
  "disallowedTools",
  "subagentNames",
] as const;

/** One agent's cloned `wire.jsonl`.
 *
 * Line for line: kimi addresses its records by line (`base.line`,
 * `legacyUndoLine`), and stops reading at the first line that does not
 * parse — so a dropped record is replaced by a no-op in its place, and a
 * line we cannot read is carried as it was. */
export function rebaseWire(
  text: string,
  agentName: string,
  workspaceId: string,
): string {
  return text
    .split("\n")
    .map((line) => rebaseWireLine(line, agentName === "main", workspaceId))
    .join("\n");
}

function rebaseWireLine(
  line: string,
  isMain: boolean,
  workspaceId: string,
): string {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isJsonRecord(record)) return line;

  if (record.type === "runtime.set_binding" && typeof record.workspaceId === "string") {
    return JSON.stringify({ ...record, workspaceId });
  }
  if (!isMain) return line;
  if (record.type === "profile.bind") {
    // An empty `config.update` changes nothing on replay — the no-op that
    // keeps the line count without a record kimi would warn about.
    return JSON.stringify({
      type: "config.update",
      ...("agentId" in record ? { agentId: record.agentId } : {}),
      ...("time" in record ? { time: record.time } : {}),
    });
  }
  if (
    record.type === "config.update" &&
    RENDERED_PROFILE_FIELDS.some((field) => field in record)
  ) {
    const kept = { ...record };
    for (const field of RENDERED_PROFILE_FIELDS) delete kept[field];
    return JSON.stringify(kept);
  }
  return line;
}
