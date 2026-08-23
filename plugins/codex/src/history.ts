import {
  firstMeaningfulUserTurn,
  shortfallOfRead,
  textFromParts,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over codex's store ([F8] browser): date-partitioned rollouts at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`; the first
 * line's `session_meta` payload carries the id and cwd. Read-only via `fs`.
 */
const ROOT = "~/.codex/sessions";

/** The log line needs a string; whatever the fs layer threw becomes one. */
function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ParsedTurn {
  role: "user" | "assistant";
  text: string;
}

/** Rollout lines: `response_item` payloads of type `message` with a content
 * array of `input_text`/`output_text` parts. Developer/meta roles are
 * plumbing, not conversation. */
export function parseRollout(jsonl: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as {
      type?: unknown;
      payload?: { type?: unknown; role?: unknown; content?: unknown };
    };
    if (record.type !== "response_item") continue;
    const payload = record.payload;
    if (payload?.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const text = textFromParts(payload.content).trim();
    if (text) turns.push({ role: payload.role, text });
  }
  return turns;
}

export function titleOf(turns: ParsedTurn[]): string | undefined {
  return firstMeaningfulUserTurn(turns);
}

const FILE_UUID = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

/** The whole rollout a page is cut from — codex reads it all and slices. */
const BODY_CAP = 8 * 1024 * 1024;

export function codexHistory(ctx: PluginContext): AgentHistory {
  /** One page of turns WITH what the reading fell short by. */
  const readPage = async (
    ref: string,
    page: { offset: number; limit: number },
  ) => {
    const file = await ctx.services.fs.readFile(ref, { maxBytes: BODY_CAP });
    const entries = parseRollout(file.text ?? "")
      .slice(page.offset, page.offset + page.limit)
      .map((t) => ({ role: t.role, text: t.text }));
    const shortfall = shortfallOfRead(file, BODY_CAP);
    return { entries, ...(shortfall ? { shortfall } : {}) };
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
      const head = await ctx.services.fs.readFile(ref, { maxBytes: 256 * 1024 });
      const text = head.text ?? "";
      const newline = text.indexOf("\n");
      // No newline in the head = one giant meta line; take the whole head
      // rather than slice(0,-1)'s silent last-char drop.
      const first = newline < 0 ? text : text.slice(0, newline);
      let cwd = "";
      try {
        const meta = JSON.parse(first) as {
          type?: unknown;
          payload?: { cwd?: unknown };
        };
        if (meta.type === "session_meta" && typeof meta.payload?.cwd === "string") {
          cwd = meta.payload.cwd;
        }
      } catch {
        // No meta line — an unexpected layout indexes with an empty cwd.
      }
      return { cwd, title: titleOf(parseRollout(text)), transcriptPath: ref };
    },
    async content(ref) {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseRollout(file.text ?? "")
        .map((t) => t.text)
        .join("\n");
    },
    // ONE reading, two contracts: the legacy method unpacks the honest one,
    // so the pair cannot drift.
    transcriptPage: readPage,
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      return (await readPage(ref, page)).entries;
    },
  };
}
