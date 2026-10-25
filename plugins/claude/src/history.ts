import {
  isJsonRecord,
  fileStub,
  firstMeaningfulUserTurn,
  jsonl,
  pageOfWalk,
  readStoreDir,
  sessionHistory,
  textFromParts,
  trimmedText,
  walkSession,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginFs,
  type PluginLogger,
  type PluginSessionStore,
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

/** One line of claude's store, as this plugin reads it: a JSON object
 * whose fields the dialect asks about one by one. The host parses the JSON
 * and validates nothing, because it knows nothing about claude. */
interface ClaudeRecord {
  type?: unknown;
  message?: unknown;
  isMeta?: unknown;
  cwd?: unknown;
  summary?: unknown;
}

/** Every field of a record is read as `unknown`, so any JSON object is one;
 * a line that is JSON but no object is not. */
function isClaudeRecord(value: unknown): value is ClaudeRecord {
  return isJsonRecord(value);
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


/** Slash-command envelopes (`<command-name>`/`<command-message>`/… and the
 * `<local-command-stdout>` echo) are stored as PLAIN user lines, not
 * `isMeta` — mechanical wrapping, not what anyone said. */
const COMMAND_ENVELOPE = /^<(command-|local-command-stdout)/;

const dialect: SessionDialect<ClaudeState, ClaudeRecord> = {
  begin: () => ({}),

  step(state, record) {
    state.cwd ??= trimmedText(record.cwd);
    // The LAST summary wins: summaries get refreshed.
    if (record.type === "summary") state.summary = trimmedText(record.summary) ?? state.summary;

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

/** What the history reads through: the store's folders, the session reader
 * over them, and the log. */
export interface HistoryPorts {
  log: PluginLogger;
  services: {
    fs: Pick<PluginFs, "readDir">;
    sessionStore: PluginSessionStore;
  };
}

export function claudeHistory(ctx: HistoryPorts): AgentHistory {
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
      format: jsonl(isClaudeRecord),
      request: { path: ref },
      dialect,
      ...extra,
    });

  return sessionHistory("claude", ctx.log, {
    async enumerate(unreadable) {
      // The root throws: a store that is not there is the core's to read.
      const slugs = await ctx.services.fs.readDir(ROOT);
      const stubs: AgentSessionStub[] = [];
      for (const slug of slugs) {
        if (slug.kind !== "dir") continue;
        const files = await readStoreDir(ctx.services.fs, slug.path, unreadable);
        for (const file of files ?? []) {
          if (
            file.kind !== "file" ||
            !fileIsTranscript(file.name) ||
            isOrphanedStoreFile(file.name)
          )
            continue;
          stubs.push(fileStub(file.name.slice(0, -".jsonl".length), file));
        }
      }
      return stubs;
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
    readPage: async (ref, page) => pageOfWalk(await walk(ref, { keep: page })),
  });
}
