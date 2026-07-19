import type {
  AgentHistory,
  AgentSessionStub,
  AgentTranscriptEntry,
  PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over claude's store ([F8] browser): one dir per project slug
 * under `~/.claude/projects/`, one `<sessionId>.jsonl` per session, cwd
 * recorded on every line. Read-only via the `fs` capability; the host owns
 * diffing and indexing.
 */
const ROOT = "~/.claude/projects";

/** A transcript line's message text, whatever shape the content took. */
function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof (part as { text?: unknown }).text === "string"
        ? ((part as { text: string }).text)
        : "",
    )
    .filter(Boolean)
    .join("\n");
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
    const record = parsed as { type?: unknown; message?: unknown };
    if (record.type !== "user" && record.type !== "assistant") continue;
    const text = textOf(record.message).trim();
    if (text) turns.push({ role: record.type, text });
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

/** A human title: the first REAL user message — command/meta preambles
 * (XML-ish tags, slash commands, skill bootstraps, the local-command
 * caveat) don't name a conversation. */
export function titleOf(turns: ParsedTurn[]): string | undefined {
  const real = turns.find(
    (t) =>
      t.role === "user" &&
      !/^([<#/[]|Base directory for this skill:|Caveat:)/.test(t.text) &&
      t.text.length > 1,
  );
  return real ? real.text.slice(0, 120) : undefined;
}

export function claudeHistory(ctx: PluginContext): AgentHistory {
  const read = (ref: string, maxBytes?: number) =>
    ctx.services.fs.readFile(ref, maxBytes === undefined ? undefined : { maxBytes });
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
        const files = await ctx.services.fs.readDir(slug.path).catch(() => []);
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
    async describe(ref) {
      const head = await read(ref, 64 * 1024);
      const text = head.text ?? "";
      return {
        cwd: cwdOf(text) ?? "",
        title: summaryOf(text) ?? titleOf(parseTurns(text)),
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
