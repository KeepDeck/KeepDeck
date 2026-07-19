import { describe, expect, it } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { codexHistory, parseRollout } from "./history";

const META = JSON.stringify({
  type: "session_meta",
  payload: { id: "019f-uuid", cwd: "/repo/wt" },
});
const LINES = [
  META,
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "plumbing" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions\nblob" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "rename the rail" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done, renamed" }],
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

describe("codex history", () => {
  it("walks the date tree and keys stubs by the filename uuid", async () => {
    const name = "rollout-2026-07-19T16-27-47-019f7af4-f57f-7dc3-ac52-6e1bb90dceec.jsonl";
    const history = codexHistory(
      ctx({}, {
        "~/.codex/sessions": [{ name: "2026", path: "/s/2026", kind: "dir" }],
        "/s/2026": [{ name: "07", path: "/s/2026/07", kind: "dir" }],
        "/s/2026/07": [{ name: "19", path: "/s/2026/07/19", kind: "dir" }],
        "/s/2026/07/19": [
          { name, path: `/s/2026/07/19/${name}`, kind: "file", size: 3, mtime: 7 },
        ],
      }),
    );
    expect(await history.list()).toEqual([
      {
        sessionId: "019f7af4-f57f-7dc3-ac52-6e1bb90dceec",
        ref: `/s/2026/07/19/${name}`,
        mtime: 7,
        size: 3,
      },
    ]);
  });

  it("describe reads the session_meta cwd; titles skip instruction blobs", async () => {
    const history = codexHistory(ctx({ "/r.jsonl": LINES }, {}));
    expect(await history.describe("/r.jsonl")).toEqual({
      cwd: "/repo/wt",
      title: "rename the rail",
    });
  });

  it("parses only user/assistant message items", () => {
    const turns = parseRollout(LINES);
    expect(turns.map((t) => t.role)).toEqual(["user", "user", "assistant"]);
  });
});
