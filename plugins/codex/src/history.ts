import {
  firstMeaningfulUserTurn,
  jsonl,
  textFromParts,
  walkSession,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginContext,
  type ReadScope,
  type SessionDialect,
} from "@keepdeck/plugin-api";
import { FILE_UUID, ROOT } from "./store";

/**
 * Discovery over codex's store ([F8] browser): date-partitioned rollouts at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`; the first
 * line's `session_meta` payload carries the id and cwd. Read-only via `fs`.
 */
// The store's shape lives in ./store, so the browser, the live tail and
// anything else that has to find a rollout read one description of it.

/** The log line needs a string; whatever the fs layer threw becomes one. */
function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One line of a rollout, as this plugin reads it. An assertion about the
 * format made in ONE place: the host parses the JSON and validates nothing,
 * because it knows nothing about codex. */
interface CodexRecord {
  type?: unknown;
  payload?: {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    cwd?: unknown;
  };
}

/** What codex records in passing, on lines the walk goes through anyway. */
interface CodexState {
  cwd?: string;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
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
    if (record.type === "session_meta") state.cwd ??= nonEmpty(record.payload?.cwd);

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


export function codexHistory(ctx: PluginContext): AgentHistory {
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
      format: jsonl<CodexRecord>(),
      request: { path: ref },
      dialect,
      ...extra,
    });

  /** One page of turns WITH what the reading fell short by. */
  const readPage = async (
    ref: string,
    page: { offset: number; limit: number },
  ) => {
    const walked = await readSession(ref, { keep: page });
    return {
      entries: walked.turns,
      ...(walked.shortfall ? { shortfall: walked.shortfall } : {}),
    };
  };

  const walk = async (path: string): Promise<AgentSessionStub[]> => {
    const out: AgentSessionStub[] = [];
    // No catch: the store's root already answered, so a date partition that
    // fails to read is a failure, not an absence — a partial walk reads as
    // "those sessions were deleted" and the index prune acts on it. The
    // throw lands in the scanner's per-agent catch: logged, nothing pruned.
    const entries = await ctx.services.fs.readDir(path);
    for (const entry of entries) {
      if (entry.kind === "dir") {
        out.push(...(await walk(entry.path)));
        continue;
      }
      const match = entry.kind === "file" ? FILE_UUID.exec(entry.name) : null;
      if (!match) continue;
      out.push({
        sessionId: match[1],
        ref: entry.path,
        mtime: entry.mtime ?? 0,
        size: entry.size ?? 0,
      });
    }
    return out;
  };
  /** The partial-tolerant twin of `walk` above: a read refusal anywhere
   * below the root skips that subtree, names it in the log, and keeps
   * walking — the skip lives INSIDE the recursion, so every depth is
   * covered by the same line. Returns whether the walk was complete. */
  const walkPartial = async (
    path: string,
    stubs: AgentSessionStub[],
  ): Promise<boolean> => {
    let entries;
    try {
      entries = await ctx.services.fs.readDir(path);
    } catch (e) {
      // A partial answer must be a NAMED one — this subtree stays
      // invisible to the index until it reads again, and silent
      // degradation is the one mode this contract forbids.
      ctx.log.warn(
        `codex: partial listing — ${path} unreadable (${errOf(e)})`,
      );
      return false;
    }
    let complete = true;
    for (const entry of entries) {
      if (entry.kind === "dir") {
        const seenAll = await walkPartial(entry.path, stubs);
        complete = seenAll && complete;
        continue;
      }
      const match = entry.kind === "file" ? FILE_UUID.exec(entry.name) : null;
      if (!match) continue;
      stubs.push({
        sessionId: match[1],
        ref: entry.path,
        mtime: entry.mtime ?? 0,
        size: entry.size ?? 0,
      });
    }
    return complete;
  };
  return {
    async list() {
      try {
        await ctx.services.fs.readDir(ROOT);
      } catch {
        return [];
      }
      return walk(ROOT);
    },
    /** See `walkPartial`; the root is probed apart so a root refusal can
     * never look like an empty store — [] with complete:true reads as
     * "every session deleted" and the host's prune would wipe this
     * agent's whole index. (Accepted cost, named in the contract: the fs
     * layer reports "no store" and "unreadable root" identically, so a
     * genuinely deleted store stops being pruned.) */
    async listing(): Promise<{ stubs: AgentSessionStub[]; complete: boolean }> {
      try {
        await ctx.services.fs.readDir(ROOT);
      } catch (e) {
        ctx.log.warn(
          `codex: store root unreadable (${errOf(e)}) — nothing enumerated`,
        );
        return { stubs: [], complete: false };
      }
      const stubs: AgentSessionStub[] = [];
      const complete = await walkPartial(ROOT, stubs);
      return { stubs, complete };
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
    // ONE reading, two contracts: the legacy method unpacks the honest one,
    // so the pair cannot drift.
    transcriptPage: readPage,
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      return (await readPage(ref, page)).entries;
    },
  };
}
