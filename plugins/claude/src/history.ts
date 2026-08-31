import {
  firstMeaningfulUserTurn,
  jsonl,
  textFromParts,
  walkSession,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginContext,
  type SessionDialect,
} from "@keepdeck/plugin-api";

/**
 * Discovery over claude's store ([F8] browser): one dir per project slug
 * under `~/.claude/projects/`, one `<sessionId>.jsonl` per session, cwd
 * recorded on every conversation line. Read-only via the `fs` capability;
 * the host owns diffing and indexing.
 *
 * Reading a session is the host's walk over the store, and everything this
 * plugin knows about claude's format lives in the dialect below: what one
 * line MEANS. No sizes, no line splitting, no JSON, no accumulation.
 */
const ROOT = "~/.claude/projects";

/** The log line needs a string; whatever the fs layer threw becomes one. */
function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A store file whose NAME is not a session id: the CLI moves a colliding
 * task file aside as `<id>.orphaned-<epoch>-<hex>.jsonl`. The enumeration
 * derives the id from the filename, so such a row would carry an address
 * that never existed. Dropped BY NAME, in BOTH enumeration paths — a
 * partial-listing walk must not let the garbage ride the older road. */
function isOrphanedStoreFile(name: string): boolean {
  return fileIsTranscript(name) && name.includes(".orphaned-");
}

/** Whether a store filename is a session transcript at all. */
function fileIsTranscript(name: string): boolean {
  return name.endsWith(".jsonl");
}

/** A transcript line's message text, whatever shape the content took. */
function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return textFromParts(content);
}

/** One line of claude's store, as this plugin reads it. An assertion about
 * the format made in ONE place: the host parses the JSON and validates
 * nothing, because it knows nothing about claude. */
interface ClaudeRecord {
  type?: unknown;
  message?: unknown;
  isMeta?: unknown;
  cwd?: unknown;
  summary?: unknown;
}

/** What claude records in passing, on lines the walk goes through anyway —
 * so none of it costs a reading of its own. */
interface ClaudeState {
  cwd?: string;
  /** The store's own conversation summary — see the precedence in
   * `describe`. Claude writes these at the head of a transcript, which is
   * what makes an early stop safe. */
  summary?: string;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** Slash-command envelopes (`<command-name>`/`<command-message>`/… and the
 * `<local-command-stdout>` echo) are stored as PLAIN user lines, not
 * `isMeta` — mechanical wrapping, not what anyone said. */
const COMMAND_ENVELOPE = /^<(command-|local-command-stdout)/;

const dialect: SessionDialect<ClaudeState, ClaudeRecord> = {
  begin: () => ({}),

  step(state, record) {
    state.cwd ??= nonEmpty(record.cwd);
    // The LAST summary wins: summaries get refreshed.
    if (record.type === "summary") state.summary = nonEmpty(record.summary) ?? state.summary;

    if (record.type !== "user" && record.type !== "assistant") return [];
    // Framework-injected lines ("Continue from where you left off.", tool
    // retry notices) are marked isMeta by claude itself — not conversation.
    if (record.isMeta === true) return [];
    const text = textOf(record.message).trim();
    if (!text) return [];
    if (record.type === "user" && COMMAND_ENVELOPE.test(text)) return [];
    return [{ role: record.type, text }];
  },

  // Claude completes a turn within one line, so nothing is ever held back.
  end: () => [],
};

export function claudeHistory(ctx: PluginContext): AgentHistory {
  const walk = (
    ref: string,
    extra: {
      keep?: { offset: number; limit: number };
      until?: (
        state: ClaudeState,
        turns: readonly AgentTranscriptEntry[],
      ) => boolean;
    } = {},
  ) =>
    walkSession({
      store: ctx.services.sessionStore,
      format: jsonl<ClaudeRecord>(),
      request: { path: ref },
      dialect,
      ...extra,
    });

  /** One page of turns WITH what the reading fell short by. */
  const readPage = async (
    ref: string,
    page: { offset: number; limit: number },
  ) => {
    const walked = await walk(ref, { keep: page });
    return {
      entries: walked.turns,
      ...(walked.shortfall ? { shortfall: walked.shortfall } : {}),
    };
  };

  return {
    async list(): Promise<AgentSessionStub[]> {
      const stubs: AgentSessionStub[] = [];
      let slugs;
      try {
        slugs = await ctx.services.fs.readDir(ROOT);
      } catch {
        return []; // no store yet — claude never ran on this machine
      }
      for (const slug of slugs) {
        if (slug.kind !== "dir") continue;
        // No catch: the store EXISTS, so a project dir that fails to read is
        // a failure, not an absence. Degrading it to [] made a partial
        // listing indistinguishable from "those sessions were deleted" — and
        // the index prune deletes what the listing omits. A throw lands in
        // the scanner's per-agent catch: logged, no upsert, no prune.
        const files = await ctx.services.fs.readDir(slug.path);
        for (const file of files) {
          if (
            file.kind !== "file" ||
            !fileIsTranscript(file.name) ||
            isOrphanedStoreFile(file.name)
          )
            continue;
          stubs.push({
            sessionId: file.name.slice(0, -".jsonl".length),
            ref: file.path,
            mtime: file.mtime ?? 0,
            size: file.size ?? 0,
          });
        }
      }
      return stubs;
    },
    /** The partial-tolerant twin of `list()` above: an unreadable project
     * dir is skipped, NAMED in the log, and the answer says so with
     * `complete: false` — the host then indexes what it got and prunes
     * nothing. `list()` keeps its stricter contract untouched; the two
     * differ exactly in what a read refusal means. */
    async listing(): Promise<{ stubs: AgentSessionStub[]; complete: boolean }> {
      const stubs: AgentSessionStub[] = [];
      let slugs;
      try {
        slugs = await ctx.services.fs.readDir(ROOT);
      } catch (e) {
        // A root refusal is NOT an empty store: [] with complete:true
        // would read as "every session deleted" and the host's prune
        // would wipe this agent's whole index. Nothing read, incomplete.
        // (Accepted cost, named in the contract: the fs layer reports
        // "no store" and "unreadable root" identically, so a genuinely
        // deleted store stops being pruned until the fs contract grows
        // a way to tell the two apart.)
        ctx.log.warn(
          `claude: store root unreadable (${errOf(e)}) — nothing enumerated`,
        );
        return { stubs, complete: false };
      }
      let complete = true;
      for (const slug of slugs) {
        if (slug.kind !== "dir") continue;
        let files;
        try {
          files = await ctx.services.fs.readDir(slug.path);
        } catch (e) {
          // A partial answer must be a NAMED one — this directory stays
          // invisible to the index until it reads again, and silent
          // degradation is the one mode this contract forbids.
          complete = false;
          ctx.log.warn(
            `claude: partial listing — ${slug.path} unreadable (${errOf(e)})`,
          );
          continue;
        }
        for (const file of files) {
          if (
            file.kind !== "file" ||
            !fileIsTranscript(file.name) ||
            isOrphanedStoreFile(file.name)
          )
            continue;
          stubs.push({
            sessionId: file.name.slice(0, -".jsonl".length),
            ref: file.path,
            mtime: file.mtime ?? 0,
            size: file.size ?? 0,
          });
        }
      }
      return { stubs, complete };
    },
    async describe(ref) {
      // Both facts a describe wants sit near the store's head — the working
      // directory on the first conversation line, the name on the first real
      // turn — so the walk stops as soon as it has them instead of reading
      // megabytes it will not look at. The condition is STRUCTURAL: "the
      // facts are collected", never "N bytes were read", so a store that
      // records them late is read further rather than answered wrongly.
      //
      // The title is asked of the same shared heuristic that produces it, not
      // of a private copy: two spellings of one rule drift, and this pair
      // would drift silently, into titles nobody could explain.
      const walked = await walk(ref, {
        until: (state, turns) =>
          state.cwd !== undefined && firstMeaningfulUserTurn(turns) !== undefined,
      });
      return {
        cwd: walked.state.cwd ?? "",
        // The store's own summary outranks the heuristic; claude writes those
        // at the head, so the stop above cannot arrive before them.
        title: walked.state.summary ?? walked.title,
        transcriptPath: ref,
        ...(walked.shortfall ? { shortfall: walked.shortfall } : {}),
      };
    },
    async content(ref) {
      return (await walk(ref)).content;
    },
    // ONE reading, two contracts: the legacy method unpacks the honest one,
    // so the pair cannot drift — `transcript` is DERIVED, never a parallel
    // implementation kept in step by hand.
    transcriptPage: readPage,
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      return (await readPage(ref, page)).entries;
    },
  };
}
