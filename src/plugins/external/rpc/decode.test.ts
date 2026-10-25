import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readManifest } from "@keepdeck/plugin-api";
import {
  decodeAgentHistoryCall,
  decodeCommandInfos,
  decodeForkPlanInput,
  decodeManifest,
  decodeResumePlanInput,
  decodeSpawnPlanInput,
  decodeDownloadRequest,
  decodeGuestMessage,
  decodeHookCall,
  decodeHostMessage,
  decodeSessionEvent,
  decodeSpawnOptions,
} from "./decode";

describe("wire decoders", () => {
  it("names a malformed guest call instead of half-reading it", () => {
    expect(() =>
      decodeGuestMessage({ kind: "call", id: 1, path: 7, args: [] }),
    ).toThrow("malformed rpc call");
  });

  it("names a malformed host result", () => {
    expect(() =>
      decodeHostMessage({ kind: "result", id: 1, ok: "yes" }),
    ).toThrow("malformed rpc result ok");
  });

  it("refuses a hook result that is not a plan", () => {
    expect(() =>
      decodeHookCall({
        agentId: "a",
        hook: "spawn.plan",
        input: {},
        output: { command: "x", args: [1], env: [] },
      }),
    ).toThrow("malformed agent hook call output");
  });

  it("refuses an unknown history method", () => {
    expect(() =>
      decodeAgentHistoryCall({ agentId: "a", method: "erase", args: [] }),
    ).toThrow("malformed agent history call method");
  });

  it("refuses spawn options without a terminal size", () => {
    expect(() => decodeSpawnOptions({ command: "x" })).toThrow(
      "malformed spawn options cols",
    );
  });

  it("refuses a download target with an unknown kind", () => {
    expect(() =>
      decodeDownloadRequest({
        id: "d",
        source: { url: "https://example.invalid/x" },
        target: { kind: "zip", path: "/tmp/x" },
      }),
    ).toThrow("malformed download target kind");
  });

  it("refuses session bytes outside one octet", () => {
    expect(() =>
      decodeSessionEvent({ type: "output", bytes: [0, 256] }),
    ).toThrow("malformed session output bytes");
  });
});

describe("the shapes decoders used to pass unchecked (task-488)", () => {
  const PLUGINS = ["claude", "codex", "files", "git", "kimi", "opencode", "run", "voice"];

  it("decodes every bundled manifest, as the host read it, to the very object it was", () => {
    for (const id of PLUGINS) {
      const raw: unknown = JSON.parse(readFileSync(new URL(`../../../../plugins/${id}/manifest.json`, import.meta.url), "utf8"));
      const read = readManifest(raw);
      if (!read.ok) throw new Error(`${id}: ${read.errors.join("; ")}`);
      expect(decodeManifest(read.manifest, "init manifest")).toBe(read.manifest);
      const message = decodeHostMessage({ kind: "init", manifest: read.manifest });
      expect(message).toEqual({ kind: "init", manifest: read.manifest });
    }
  });

  it("refuses a manifest whose capabilities or contributions the host's reader would refuse, naming them", () => {
    const base = {
      id: "dev.x", name: "X", version: "1.0.0", minApiVersion: 1, category: "deck",
      capabilities: [], contributes: {},
    };
    expect(() => decodeManifest(base, "init manifest")).not.toThrow();
    expect(() => decodeManifest({ ...base, capabilities: [{ kind: "teleport" }] }, "init manifest"))
      .toThrow(/^malformed init manifest: .*capabilities/);
    expect(() => decodeManifest({ ...base, contributes: { dockTabs: "not a list" } }, "init manifest"))
      .toThrow(/^malformed init manifest: .*contributes/);
    expect(() => decodeHostMessage({ kind: "init", manifest: { ...base, capabilities: "all" } }))
      .toThrow(/^malformed init manifest: /);
  });

  const command = { id: "pane.write", title: "Write", args: [
    { name: "text", type: "string", required: true, description: "What to write" },
    { name: "submit", type: "boolean", description: "Press enter" },
  ] };

  it("passes a command list with every declared argument whole, as it came", () => {
    const list = [command, { id: "deck.focus", title: "Focus", args: [] }];
    expect(decodeCommandInfos(list, "command list")).toBe(list);
  });

  it("refuses a command argument by its path", () => {
    const withArg = (arg: unknown) => [{ ...command, args: [command.args[0], arg] }];
    expect(() => decodeCommandInfos(withArg({ name: "n", type: "date", description: "d" }), "command list"))
      .toThrow("malformed command list[0].args[1].type: expected one of string, boolean, number");
    expect(() => decodeCommandInfos(withArg({ name: "n", type: "number" }), "command list"))
      .toThrow("malformed command list[0].args[1].description: expected a string");
    expect(() => decodeCommandInfos(withArg({ name: "n", type: "number", required: "yes", description: "d" }), "command list"))
      .toThrow("malformed command list[0].args[1].required: expected a boolean");
    expect(() => decodeCommandInfos(withArg("text"), "command list"))
      .toThrow("malformed command list[0].args[1]: expected an object");
    expect(() => decodeCommandInfos([{ ...command, args: "text" }], "command list"))
      .toThrow("malformed command list[0].args: expected an array");
  });

  const spawn = {
    paneId: "pane-1",
    workspace: { id: "ws-1", instance: "workspace-a-b-1" },
    cwd: "/w",
    yolo: true,
    skills: { claudePluginDir: "/s/c", opencodeConfigDir: "/s/o", skillsDir: "/s/k" },
    mcp: { servers: [
      { name: "keepdeck", transport: "stdio", command: "/bin/kd", args: ["--mcp"], envPassthrough: ["KD"] },
      { name: "remote", transport: "http", url: "https://x", headers: { "X-A": "1" }, bearerTokenEnv: "TOKEN" },
    ] },
    target: { kind: "nativeServer", endpoint: "ws://vps:4500" },
  };

  it("passes a spawn, resume and fork input with skills, MCP servers and a target, as it came", () => {
    expect(decodeSpawnPlanInput(spawn, "spawn plan input")).toBe(spawn);
    const resume = { ...spawn, sessionId: "s1" };
    expect(decodeResumePlanInput(resume, "resume plan input")).toBe(resume);
    const fork = { ...resume, sourceCwd: "/src", transcriptPath: "/t.jsonl" };
    expect(decodeForkPlanInput(fork, "fork plan input")).toBe(fork);
    const bare = { paneId: "p", workspace: spawn.workspace, cwd: "/w" };
    expect(decodeSpawnPlanInput(bare, "spawn plan input")).toBe(bare);
  });

  it("refuses each nested part of a spawn input by its path", () => {
    const refused: [unknown, string][] = [
      [{ ...spawn, skills: { ...spawn.skills, skillsDir: 7 } }, "spawn plan input.skills.skillsDir: expected a string"],
      [{ ...spawn, skills: "dir" }, "spawn plan input.skills: expected an object"],
      [{ ...spawn, mcp: { servers: "all" } }, "spawn plan input.mcp.servers: expected an array"],
      [{ ...spawn, mcp: { servers: [{ ...spawn.mcp.servers[0], args: "--mcp" }] } }, "spawn plan input.mcp.servers[0].args: expected an array of strings"],
      [{ ...spawn, mcp: { servers: [spawn.mcp.servers[0], { name: "x", transport: "sse", url: "u" }] } }, `spawn plan input.mcp.servers[1].transport: expected "stdio" or "http"`],
      [{ ...spawn, mcp: { servers: [{ ...spawn.mcp.servers[1], headers: { "X-A": 1 } }] } }, "spawn plan input.mcp.servers[0].headers.X-A: expected a string"],
      [{ ...spawn, target: { kind: "ssh", endpoint: "e" } }, `spawn plan input.target.kind: expected "nativeServer"`],
      [{ ...spawn, workspace: { id: "ws-1" } }, "spawn plan input.workspace: expected a workspace ref"],
      [{ ...spawn, yolo: "yes" }, "spawn plan input.yolo: expected a boolean"],
    ];
    for (const [input, message] of refused) {
      expect(() => decodeSpawnPlanInput(input, "spawn plan input")).toThrow(`malformed ${message}`);
    }
    expect(() => decodeResumePlanInput(spawn, "resume plan input")).toThrow("malformed resume plan input.sessionId: expected a string");
    expect(() => decodeForkPlanInput({ ...spawn, sessionId: "s" }, "fork plan input")).toThrow("malformed fork plan input.sourceCwd: expected a string");
  });
});
