import type {
  AgentHistory,
  AgentSessionStub,
  AgentTranscriptEntry,
  PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over kimi's store ([F8] browser): sessions live at
 * `~/.kimi-code/sessions/wd_<key>/session_<id>/` — `state.json` carries
 * workDir + title, `agents/main/wire.jsonl` is the conversation. The wire
 * file is the change fingerprint (a dir's mtime doesn't move when a child
 * file grows). Read-only via `fs`.
 */
const ROOT = "~/.kimi-code/sessions";

interface ParsedTurn {
  role: "user" | "assistant" | "other";
  text: string;
}

/** Wire lines: `context.append_message` events carry whole messages with a
 * text-part content array; anything else (tool calls, thinking, usage) is
 * not conversation text. */
export function parseWire(jsonl: string): ParsedTurn[] {
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
      message?: { role?: unknown; content?: unknown };
    };
    if (record.type !== "context.append_message") continue;
    const role = record.message?.role;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((part) =>
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) continue;
    turns.push({
      role: role === "user" ? "user" : role === "assistant" ? "assistant" : "other",
      text,
    });
  }
  return turns;
}

const WIRE_SUFFIX = "/agents/main/wire.jsonl";

export function kimiHistory(ctx: PluginContext): AgentHistory {
  return {
    async list(): Promise<AgentSessionStub[]> {
      const stubs: AgentSessionStub[] = [];
      let wdDirs;
      try {
        wdDirs = await ctx.services.fs.readDir(ROOT);
      } catch {
        return [];
      }
      for (const wd of wdDirs) {
        if (wd.kind !== "dir" || !wd.name.startsWith("wd_")) continue;
        const sessions = await ctx.services.fs.readDir(wd.path).catch(() => []);
        for (const session of sessions) {
          if (session.kind !== "dir" || !session.name.startsWith("session_")) continue;
          const main = await ctx.services.fs
            .readDir(`${session.path}/agents/main`)
            .catch(() => []);
          const wire = main.find((f) => f.name === "wire.jsonl");
          if (!wire) continue; // never messaged — nothing to index
          stubs.push({
            sessionId: session.name,
            ref: wire.path,
            mtime: wire.mtime ?? 0,
            size: wire.size ?? 0,
          });
        }
      }
      return stubs;
    },
    async describe(ref) {
      const sessionDir = ref.endsWith(WIRE_SUFFIX)
        ? ref.slice(0, -WIRE_SUFFIX.length)
        : ref;
      const state = await ctx.services.fs
        .readFile(`${sessionDir}/state.json`)
        .catch(() => null);
      try {
        const parsed = JSON.parse(state?.text ?? "") as {
          workDir?: unknown;
          title?: unknown;
        };
        return {
          cwd: typeof parsed.workDir === "string" ? parsed.workDir : "",
          ...(typeof parsed.title === "string" &&
            parsed.title !== "" && { title: parsed.title.slice(0, 120) }),
        };
      } catch {
        return { cwd: "" };
      }
    },
    async content(ref) {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseWire(file.text ?? "")
        .filter((t) => t.role !== "other")
        .map((t) => t.text)
        .join("\n");
    },
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseWire(file.text ?? "")
        .slice(page.offset, page.offset + page.limit)
        .map((t) => ({ role: t.role, text: t.text }));
    },
  };
}
