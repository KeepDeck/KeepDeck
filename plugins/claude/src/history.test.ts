import { describe, expect, it } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { claudeHistory } from "./history";

const LINES = [
  JSON.stringify({ type: "summary", summary: "meta" }),
  JSON.stringify({
    type: "user",
    cwd: "/repo/wt",
    message: { role: "user", content: "<system-hint>noise</system-hint>" },
  }),
  JSON.stringify({
    type: "user",
    cwd: "/repo/wt",
    message: { role: "user", content: "fix the auth bug" },
  }),
  '{"torn',
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "found it in refresh()" }],
    },
  }),
].join("\n");

function ctx(files: Record<string, string>, dirs: Record<string, unknown[]>) {
  return {
    services: {
      fs: {
        readDir: async (path: string) => {
          const entries = dirs[path];
          if (!entries) throw new Error("no dir");
          return entries;
        },
        readFile: async (path: string) => ({
          path,
          text: files[path] ?? null,
          isBinary: false,
          size: 0,
          truncated: false,
        }),
      },
    },
  } as unknown as PluginContext;
}

describe("claude history", () => {
  it("lists slug dirs' jsonl files as stubs", async () => {
    const history = claudeHistory(
      ctx({}, {
        "~/.claude/projects": [
          { name: "-repo-wt", path: "/h/p/-repo-wt", kind: "dir" },
        ],
        "/h/p/-repo-wt": [
          { name: "u1.jsonl", path: "/h/p/-repo-wt/u1.jsonl", kind: "file", size: 9, mtime: 5 },
          { name: "notes.txt", path: "/h/p/-repo-wt/notes.txt", kind: "file" },
        ],
      }),
    );
    expect(await history.list()).toEqual([
      { sessionId: "u1", ref: "/h/p/-repo-wt/u1.jsonl", mtime: 5, size: 9 },
    ]);
  });

  it("describe pulls cwd from the lines and titles by the first REAL user turn", async () => {
    const history = claudeHistory(ctx({ "/f.jsonl": LINES }, {}));
    expect(await history.describe("/f.jsonl")).toEqual({
      cwd: "/repo/wt",
      title: "fix the auth bug",
    });
  });

  it("content and transcript keep user+assistant turns, skip noise and torn lines", async () => {
    const history = claudeHistory(ctx({ "/f.jsonl": LINES }, {}));
    expect(await history.content("/f.jsonl")).toContain("found it in refresh()");
    const page = await history.transcript("/f.jsonl", { offset: 0, limit: 10 });
    expect(page.map((e) => e.role)).toEqual(["user", "user", "assistant"]);
  });
});
