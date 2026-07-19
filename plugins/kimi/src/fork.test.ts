import { describe, expect, it } from "vitest";
import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";
import { kimiForkPlan, wdKey } from "./fork";

const HOME = "/Users/u/.kimi-code";
const SRC_DIR = `${HOME}/sessions/wd_a_3c3646ae2a28/session_orig-1`;

const STATE = {
  createdAt: "2026-07-18T18:22:16.068Z",
  title: "auth investigation",
  isCustomTitle: false,
  agents: {
    main: {
      homedir: `${SRC_DIR}/agents/main`,
      type: "main",
      parentAgentId: null,
    },
  },
  custom: {},
  workDir: "/old/place",
  lastPrompt: "hi",
};

interface Fx {
  ctx: PluginContext;
  writes: Map<string, string>;
  copies: [string, string][];
  appends: [string, string][];
}

function fixture(stateText: string | null = JSON.stringify(STATE)): Fx {
  const writes = new Map<string, string>();
  const copies: [string, string][] = [];
  const appends: [string, string][] = [];
  const ctx = {
    services: {
      fs: {
        readFile: async (path: string) => ({
          path,
          text: stateText,
          isBinary: stateText === null,
          size: stateText?.length ?? 0,
          truncated: false,
        }),
      },
      fsWrite: {
        writeFile: async (path: string, text: string) => {
          writes.set(path, text);
        },
        copyFile: async (src: string, dst: string) => {
          copies.push([src, dst]);
        },
        appendLine: async (path: string, line: string) => {
          appends.push([path, line]);
        },
      },
    },
  } as unknown as PluginContext;
  return { ctx, writes, copies, appends };
}

const forkInput = (cwd: string): ForkPlanInput => ({
  paneId: "pane-1",
  workspace: { id: "ws-1", instance: "wsi-1" } as ForkPlanInput["workspace"],
  cwd,
  sessionId: "session_orig-1",
  sourceCwd: "/old/place",
  transcriptPath: `${SRC_DIR}/agents/main/wire.jsonl`,
});

describe("wdKey", () => {
  it("matches kimi's real store folder for a probed directory", async () => {
    // Golden pair observed live on kimi 0.27: this exact directory files
    // under this exact wd key (sha256 prefix + lowercased basename).
    expect(await wdKey("/Users/artem/Projects/KeepDeck/Workspace")).toBe(
      "wd_workspace_7dfa19e1d90d",
    );
  });
});

describe("kimiForkPlan", () => {
  it("clones the session under a fresh id: patched state, wire copy, index line", async () => {
    const fx = fixture();
    const newId = await kimiForkPlan(fx.ctx, forkInput("/new/target"));

    expect(newId).toMatch(/^session_[0-9a-f-]{36}$/);
    const dstDir = `${HOME}/sessions/${await wdKey("/new/target")}/${newId}`;

    const state = JSON.parse(fx.writes.get(`${dstDir}/state.json`)!);
    expect(state.workDir).toBe("/new/target"); // the resume gate
    expect(state.agents.main.homedir).toBe(`${dstDir}/agents/main`);
    expect(state.title).toBe("auth investigation"); // everything else survives

    expect(fx.copies).toContainEqual([
      `${SRC_DIR}/agents/main/wire.jsonl`,
      `${dstDir}/agents/main/wire.jsonl`,
    ]);

    expect(fx.appends).toHaveLength(1);
    expect(fx.appends[0][0]).toBe(`${HOME}/session_index.jsonl`);
    expect(JSON.parse(fx.appends[0][1])).toEqual({
      sessionId: newId,
      sessionDir: dstDir,
      workDir: "/new/target",
    });
  });

  it("rejects without a transcript path or on a foreign layout — zero writes", async () => {
    const fx = fixture();
    await expect(
      kimiForkPlan(fx.ctx, { ...forkInput("/t"), transcriptPath: undefined }),
    ).rejects.toThrow("no recorded transcript path");
    await expect(
      kimiForkPlan(fx.ctx, {
        ...forkInput("/t"),
        transcriptPath: "/odd/place/wire.jsonl",
      }),
    ).rejects.toThrow("unexpected store layout");
    expect(fx.writes.size).toBe(0);
    expect(fx.appends).toHaveLength(0);
  });

  it("rejects when state.json lost the fields the gate depends on", async () => {
    const fx = fixture(JSON.stringify({ title: "x" }));
    await expect(kimiForkPlan(fx.ctx, forkInput("/t"))).rejects.toThrow(
      "layout changed",
    );
    expect(fx.writes.size).toBe(0);
  });
});
