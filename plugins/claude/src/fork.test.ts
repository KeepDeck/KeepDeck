import { describe, expect, it } from "vitest";
import type { FsCopyOptions, FsEntry, ForkPlanInput } from "@keepdeck/plugin-api";
import { claudeProjectFolder, forkClaudeSession, type ClaudeForkStore } from "./fork";
import { present } from "@keepdeck/plugin-api/testing";

const C = "/Users/u/.claude";
const SOURCE_DIR = `${C}/projects/-old-worktree`;

/** An in-memory store: files by absolute path, folders implied by them. */
function fakeStore(files: string[], ids = ["F", "T"]) {
  const copies: Array<[string, string, FsCopyOptions | undefined]> = [];
  const removed: string[] = [];
  let failOn: string | null = null;
  const queue = [...ids];
  const store: ClaudeForkStore = {
    newId: () => present(queue.shift(), "the first item"),
    fs: {
      readDir: async (path: string) => {
        const children = new Map<string, FsEntry>();
        for (const file of files) {
          if (!file.startsWith(`${path}/`)) continue;
          const [name, ...rest] = file.slice(path.length + 1).split("/");
          children.set(name, {
            name,
            path: `${path}/${name}`,
            kind: rest.length > 0 ? "dir" : "file",
          });
        }
        if (children.size === 0) throw new Error(`no such directory: ${path}`);
        return [...children.values()];
      },
    },
    fsWrite: {
      copyFile: async (src, dst, options) => {
        if (src === failOn) throw new Error("disk full");
        copies.push([src, dst, options]);
      },
      remove: async (path) => {
        removed.push(path);
      },
    },
  };
  return { store, copies, removed, failOn: (path: string) => (failOn = path) };
}

const input = (over: Partial<ForkPlanInput> = {}): ForkPlanInput => ({
  paneId: "pane-1",
  workspace: { id: "ws-1", instance: "i-1" },
  cwd: "/repo/wt_2.x",
  sessionId: "S",
  sourceCwd: "/old/worktree",
  transcriptPath: `${SOURCE_DIR}/S.jsonl`,
  ...over,
});

const REWRITE = { replace: [[`${SOURCE_DIR}/S/`, `${C}/projects/-repo-wt-2-x/F/`]] };

describe("claude fork", () => {
  it("lays the whole session out under the fork's own id, then lets claude fork a throwaway copy", async () => {
    const { store, copies } = fakeStore([
      `${SOURCE_DIR}/S.jsonl`,
      `${SOURCE_DIR}/S/subagents/agent-a.jsonl`,
      `${SOURCE_DIR}/S/subagents/agent-a.meta.json`,
      `${SOURCE_DIR}/S/subagents/workflows/run-1/agent-b.jsonl`,
      `${SOURCE_DIR}/S/tool-results/out.txt`,
      `${SOURCE_DIR}/S/workflows/scripts/build-1.js`,
      `${SOURCE_DIR}/S/custom-title.json`,
      // Live-job state the source still owns: not carried.
      `${SOURCE_DIR}/S/remote-agents/remote-agent-1.meta.json`,
      `${SOURCE_DIR}/S/mcp-tasks/mcp-task-1.meta.json`,
      `${SOURCE_DIR}/S/ccr-tip.json`,
      `${C}/tasks/S/1.json`,
      `${C}/tasks/S/.lock`,
      `${C}/tasks/OTHER/1.json`,
    ]);
    const T = `${C}/projects/-repo-wt-2-x`;
    const launch = await forkClaudeSession(store, input());

    expect(launch).toEqual({
      args: ["--session-id", "F", "--fork-session", "--resume", "T"],
      discard: {
        onceStarted: [`${T}/T.jsonl`],
        ifNeverStarted: [`${T}/T.jsonl`, `${T}/F`, `${C}/tasks/F`],
      },
    });
    expect(copies).toEqual([
      [`${SOURCE_DIR}/S.jsonl`, `${T}/T.jsonl`, REWRITE],
      [`${SOURCE_DIR}/S/subagents/agent-a.jsonl`, `${T}/F/subagents/agent-a.jsonl`, REWRITE],
      [`${SOURCE_DIR}/S/subagents/agent-a.meta.json`, `${T}/F/subagents/agent-a.meta.json`, REWRITE],
      [
        `${SOURCE_DIR}/S/subagents/workflows/run-1/agent-b.jsonl`,
        `${T}/F/subagents/workflows/run-1/agent-b.jsonl`,
        REWRITE,
      ],
      // Not text claude writes paths into: copied byte for byte.
      [`${SOURCE_DIR}/S/tool-results/out.txt`, `${T}/F/tool-results/out.txt`, undefined],
      [`${SOURCE_DIR}/S/workflows/scripts/build-1.js`, `${T}/F/workflows/scripts/build-1.js`, undefined],
      [`${SOURCE_DIR}/S/custom-title.json`, `${T}/F/custom-title.json`, REWRITE],
      [`${C}/tasks/S/1.json`, `${C}/tasks/F/1.json`, undefined],
    ]);
  });

  it("forks in place the same way: the throwaway copy never takes the source's name", async () => {
    const { store, copies } = fakeStore([`${SOURCE_DIR}/S.jsonl`]);
    const launch = await forkClaudeSession(store, input({ cwd: "/old/worktree" }));
    expect(copies).toEqual([
      [
        `${SOURCE_DIR}/S.jsonl`,
        `${SOURCE_DIR}/T.jsonl`,
        { replace: [[`${SOURCE_DIR}/S/`, `${SOURCE_DIR}/F/`]] },
      ],
    ]);
    expect(launch).toMatchObject({ args: ["--session-id", "F", "--fork-session", "--resume", "T"] });
  });

  it("spells the replaced folder the way a transcript does — JSON-escaped", async () => {
    // A project folder name is all alphanumerics and dashes; the store root
    // (a CLAUDE_CONFIG_DIR) is what can carry a quote.
    const root = `/Users/u/.cl"aude`;
    const { store, copies } = fakeStore([`${root}/projects/-a-b/S.jsonl`]);
    await forkClaudeSession(store, input({ transcriptPath: `${root}/projects/-a-b/S.jsonl` }));
    expect(copies[0][2]).toEqual({
      replace: [[`/Users/u/.cl\\"aude/projects/-a-b/S/`, `/Users/u/.cl\\"aude/projects/-repo-wt-2-x/F/`]],
    });
  });

  it("refuses without a transcript, or with one that is not this session's, writing nothing", async () => {
    for (const transcriptPath of [undefined, `${SOURCE_DIR}/OTHER.jsonl`, `${SOURCE_DIR}/S.txt`]) {
      const { store, copies } = fakeStore([`${SOURCE_DIR}/S.jsonl`]);
      const asked = input();
      if (transcriptPath === undefined) delete asked.transcriptPath;
      else asked.transcriptPath = transcriptPath;
      await expect(forkClaudeSession(store, asked)).rejects.toThrow("claude fork of S");
      expect(copies).toEqual([]);
    }
    const odd = fakeStore(["/somewhere/odd/S.jsonl"]);
    await expect(
      forkClaudeSession(odd.store, input({ transcriptPath: "/somewhere/odd/S.jsonl" })),
    ).rejects.toThrow("unexpected store layout");
  });

  it("a failed copy takes back everything the surgery made, then fails the plan", async () => {
    const { store, removed, failOn } = fakeStore([
      `${SOURCE_DIR}/S.jsonl`,
      `${SOURCE_DIR}/S/subagents/agent-a.jsonl`,
    ]);
    failOn(`${SOURCE_DIR}/S/subagents/agent-a.jsonl`);
    await expect(forkClaudeSession(store, input())).rejects.toThrow("disk full");
    const T = `${C}/projects/-repo-wt-2-x`;
    expect(removed).toEqual([`${T}/T.jsonl`, `${T}/F`, `${C}/tasks/F`]);
  });
});

describe("claudeProjectFolder", () => {
  it("turns every non-alphanumeric character into a dash", () => {
    expect(claudeProjectFolder("/Users/John Doe/Projects/app (v2)")).toBe(
      "-Users-John-Doe-Projects-app--v2-",
    );
  });

  it("cuts a long one at 200 and appends claude's hash of the whole path", () => {
    // The two 321-char directories of the live check (task-403): claude
    // made `…-8le25x` and `…-px244v` for them.
    const base = "/private/var/folders/ks/rm0rw8313zn6wy594dhnx3fw0000gn/T/keepdeck-claude403-53glni77/";
    const source = `${base}long source space ${"s".repeat(60)}/nested source ${"a".repeat(65)}/leaf source ${"b".repeat(65)}`;
    const target = `${base}long target space ${"t".repeat(60)}/nested target ${"c".repeat(65)}/leaf target ${"d".repeat(65)}`;
    expect(source).toHaveLength(321);
    expect(claudeProjectFolder(source)).toBe(
      `${source.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-8le25x`,
    );
    expect(claudeProjectFolder(target).endsWith("-px244v")).toBe(true);
    expect(claudeProjectFolder(target)).toHaveLength(207);
  });
});
