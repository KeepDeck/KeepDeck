import {
  firstMeaningfulUserTurn,
  textFromParts,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over claude's store ([F8] browser): one dir per project slug
 * under `~/.claude/projects/`, one `<sessionId>.jsonl` per session, cwd
 * recorded on every line. Read-only via the `fs` capability; the host owns
 * diffing and indexing.
 */
const ROOT = "~/.claude/projects";

/** The log line needs a string; whatever the fs layer threw becomes one. */
function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A transcript line's message text, whatever shape the content took. */
function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return textFromParts(content);
}

interface ParsedTurn {
  role: "user" | "assistant";
  text: string;
}

function parseTurns(jsonl: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn tail or foreign line never sinks the session
    }
    const record = parsed as {
      type?: unknown;
      message?: unknown;
      isMeta?: unknown;
    };
    if (record.type !== "user" && record.type !== "assistant") continue;
    // Framework-injected lines ("Continue from where you left off.", tool
    // retry notices) are marked isMeta by claude itself — not conversation.
    if (record.isMeta === true) continue;
    const text = textOf(record.message).trim();
    if (!text) continue;
    // Slash-command envelopes (<command-name>/<command-message>/… and the
    // <local-command-stdout> echo) are stored as PLAIN user lines, not
    // isMeta — mechanical wrapping, not what anyone said.
    if (record.type === "user" && /^<(command-|local-command-stdout)/.test(text)) {
      continue;
    }
    turns.push({ role: record.type, text });
  }
  return turns;
}

/** The first line carrying a cwd — claude stamps it on every record. */
function cwdOf(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd !== "") return cwd;
    } catch {
      continue;
    }
  }
  return null;
}

/** Claude's own conversation summary, when the store recorded one —
 * `{type:"summary", summary}` lines sit at the head of the jsonl. The last
 * one wins (summaries get refreshed). */
export function summaryOf(jsonl: string): string | undefined {
  let latest: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"summary"')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; summary?: unknown };
      if (parsed.type === "summary" && typeof parsed.summary === "string") {
        const text = parsed.summary.trim();
        if (text) latest = text;
      }
    } catch {
      continue;
    }
  }
  return latest;
}

/** A human title: the shared first-real-user-turn heuristic. */
export function titleOf(turns: ParsedTurn[]): string | undefined {
  return firstMeaningfulUserTurn(turns);
}

export function claudeHistory(ctx: PluginContext): AgentHistory {
  const read = (ref: string, maxBytes?: number) =>
    ctx.services.fs.readFile(ref, maxBytes === undefined ? undefined : { maxBytes });
  /** The slug dir's `sessions-index.json` firstPrompt for this session, run
   * through the same title heuristic — claude's own index is far cheaper
   * than scanning megabytes of transcript. `undefined` = no usable entry. */
  const indexedTitle = async (ref: string): Promise<string | undefined> => {
    const dir = ref.slice(0, ref.lastIndexOf("/"));
    const sessionId = ref.slice(dir.length + 1, -".jsonl".length);
    try {
      const file = await read(`${dir}/sessions-index.json`, 512 * 1024);
      const parsed = JSON.parse(file.text ?? "") as {
        entries?: unknown;
      };
      const list = Array.isArray(parsed.entries) ? parsed.entries : [];
      const entry = list.find(
        (s) =>
          typeof (s as { sessionId?: unknown }).sessionId === "string" &&
          (s as { sessionId: string }).sessionId === sessionId,
      ) as { firstPrompt?: unknown } | undefined;
      if (typeof entry?.firstPrompt !== "string") return undefined;
      // Claude writes the LITERAL string "No prompt" for promptless
      // sessions — a placeholder, not a title.
      if (entry.firstPrompt.trim() === "No prompt") return undefined;
      // The recorded firstPrompt can itself be a preamble — same filter.
      return titleOf([{ role: "user", text: entry.firstPrompt.trim() }]);
    } catch {
      return undefined; // no index / foreign shape — full read decides
    }
  };
  /** The store's own fork marker, when this transcript is a COPY: claude
   * keeps a `.meta.json` sidecar beside the transcript with `isFork` (and
   * lineage ids we do not need). The marker's MOMENT is the sidecar's
   * mtime — the file is created at the branch point; its content carries
   * no timestamp of its own (verified against the CLI's own schema).
   * `undefined` = not a fork, or no readable marker: an original must
   * never inherit a copy's badge. */
  const forkedAtOf = async (ref: string): Promise<number | undefined> => {
    if (!ref.endsWith(".jsonl")) return undefined;
    const dir = ref.slice(0, ref.lastIndexOf("/"));
    try {
      const sidecar = `${ref.slice(0, -".jsonl".length)}.meta.json`;
      const file = await read(sidecar, 64 * 1024);
      const parsed = JSON.parse(file.text ?? "") as { isFork?: unknown };
      if (parsed.isFork !== true) return undefined;
      // readFile carries no mtime — the DIRECTORY listing does, one entry
      // per file, and the sidecar was just proven to exist by the read.
      const entries = await ctx.services.fs.readDir(dir);
      const entry = entries.find((e) => e.path === sidecar);
      return entry?.mtime;
    } catch {
      return undefined; // no sidecar / foreign shape — an original, then
    }
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
          if (file.kind !== "file" || !file.name.endsWith(".jsonl")) continue;
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
          if (file.kind !== "file" || !file.name.endsWith(".jsonl")) continue;
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
      // cwd sits on the first lines — a 64KB head covers it. Titles first
      // try claude's own per-project sessions-index.json (firstPrompt),
      // which spares the full read; only when the index lacks a usable
      // entry does the capped FULL read run — skill bootstraps and
      // attachments push the first REAL user turn hundreds of KB in, so a
      // head alone left most sessions titled by their UUID.
      // Precedence is DELIBERATE: a usable index title pre-empts even the
      // store's own summary line — the summary lives megabytes into the
      // transcript, and finding it would cost exactly the full read the
      // index fast path exists to avoid.
      const head = await read(ref, 64 * 1024);
      const cwd = cwdOf(head.text ?? "") ?? "";
      const fromIndex = await indexedTitle(ref);
      const forkedAt = await forkedAtOf(ref);
      if (fromIndex !== undefined) {
        return {
          cwd,
          title: fromIndex,
          transcriptPath: ref,
          ...(forkedAt !== undefined && { forkedAt }),
        };
      }
      const file = await read(ref, 8 * 1024 * 1024);
      const text = file.text ?? "";
      return {
        cwd: cwd || (cwdOf(text) ?? ""),
        title: summaryOf(text) ?? titleOf(parseTurns(text)),
        transcriptPath: ref,
        ...(forkedAt !== undefined && { forkedAt }),
      };
    },
    async content(ref) {
      const file = await read(ref, 8 * 1024 * 1024);
      return parseTurns(file.text ?? "")
        .map((t) => t.text)
        .join("\n");
    },
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      const file = await read(ref, 8 * 1024 * 1024);
      return parseTurns(file.text ?? "")
        .slice(page.offset, page.offset + page.limit)
        .map((t) => ({ role: t.role, text: t.text }));
    },
  };
}
