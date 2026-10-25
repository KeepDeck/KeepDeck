import {
  isJsonRecord,
  fileStub,
  firstMeaningfulUserTurn,
  jsonl,
  pageOfWalk,
  sessionHistory,
  textFromParts,
  trimmedText,
  walkSession,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginLogger,
  type PluginSessionStore,
  type ReadScope,
  type SessionDialect,
} from "@keepdeck/plugin-api";
import { walkRollouts, type StorePorts } from "./store";

/**
 * Discovery over codex's store ([F8] browser): date-partitioned rollouts at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`; the first
 * line's `session_meta` payload carries the id and cwd. Read-only via `fs`.
 */
// The store's shape lives in ./store, so the browser, the live tail and
// anything else that has to find a rollout read one description of it.

/** One line of a rollout, as this plugin reads it. The host parses the
 * JSON and validates nothing, because it knows nothing about codex. */
interface CodexRecord {
  type?: unknown;
  payload?: {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    cwd?: unknown;
  };
}

/** A JSON object whose `payload`, when there is one, is an object too. */
function isCodexRecord(value: unknown): value is CodexRecord {
  return isJsonRecord(value) && (value.payload === undefined || isJsonRecord(value.payload));
}

/** What codex records in passing, on lines the walk goes through anyway. */
interface CodexState {
  cwd?: string;
}


/** Rollout lines: `response_item` payloads of type `message` with a content
 * array of `input_text`/`output_text` parts. Developer/meta roles are
 * plumbing, not conversation. */
const dialect: SessionDialect<CodexState, CodexRecord> = {
  begin: () => ({}),

  step(state, record) {
    // `session_meta` opens the rollout and carries the working directory;
    // noticing it here is what replaces the separate read of the head. A
    // rollout can carry several (subagent threads) — the FIRST wins, which
    // is what parsing the first line always did.
    if (record.type === "session_meta") state.cwd ??= trimmedText(record.payload?.cwd);

    if (record.type !== "response_item") return [];
    const payload = record.payload;
    if (payload?.type !== "message") return [];
    if (payload.role !== "user" && payload.role !== "assistant") return [];
    const text = textFromParts(payload.content).trim();
    return text ? [{ role: payload.role, text }] : [];
  },

  // A rollout line is one whole message, so nothing is ever held back.
  end: () => [],
};


/** What the history reads through: the store's listings, the session
 * reader over them, and the log. */
export interface HistoryPorts {
  log: PluginLogger;
  services: StorePorts["services"] & { sessionStore: PluginSessionStore };
}

export function codexHistory(ctx: HistoryPorts): AgentHistory {
  /** One reading of ONE rollout. (`walk`/`walkPartial` below are a different
   * job entirely: they walk the store's DIRECTORIES.) */
  const readSession = (
    ref: string,
    extra: {
      keep?: { offset: number; limit: number };
      until?: (
        state: CodexState,
        turns: readonly AgentTranscriptEntry[],
      ) => boolean;
      scope?: ReadScope;
    } = {},
  ) =>
    walkSession({
      store: ctx.services.sessionStore,
      format: jsonl(isCodexRecord),
      request: { path: ref },
      dialect,
      ...extra,
    });

  return sessionHistory("codex", ctx.log, {
    async enumerate(unreadable) {
      const stubs: AgentSessionStub[] = [];
      await walkRollouts(ctx, {
        file: (entry, sessionId) => stubs.push(fileStub(sessionId, entry)),
        unreadable,
      });
      return stubs;
    },
    async describe(ref) {
      // Both facts a describe wants sit at the rollout's start: the working
      // directory on the opening `session_meta`, the name on the first real
      // turn. `head` says so — and it is the PLUGIN's claim, true of this
      // format and false of others, while how far a head reaches is the
      // host's number. Without it, a rollout with no titling turn at all
      // (subagent threads: 95 of 278 on a real store) would be read to its
      // end for an answer that is not there.
      const walked = await readSession(ref, {
        scope: "head",
        until: (state, turns) =>
          state.cwd !== undefined && firstMeaningfulUserTurn(turns) !== undefined,
      });
      return {
        cwd: walked.state.cwd ?? "",
        title: walked.title,
        transcriptPath: ref,
        // Spread even though a head reading never produces one: it makes the
        // absence FOLLOW from the scope instead of coinciding with it. Drop
        // the spread and "describe does not mark" rests on two unrelated
        // facts at once — and the day the scope widens, the mark would go
        // missing silently, with nothing in this file to notice.
        ...(walked.shortfall ? { shortfall: walked.shortfall } : {}),
      };
    },
    async content(ref) {
      return (await readSession(ref)).content;
    },
    readPage: async (ref, page) => pageOfWalk(await readSession(ref, { keep: page })),
  });
}
