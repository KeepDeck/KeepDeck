import { describe, expect, it } from "vitest";
import { rebaseState, rebaseWire } from "./forkRebase";

const OLD_DIR = "/Users/u/.kimi-code/sessions/wd_a_111111111111/session_old";
const TARGET = {
  cwd: "/new/target",
  sessionId: "session_new",
  sessionDir: "/Users/u/.kimi-code/sessions/wd_target_222222222222/session_new",
};
const WS = "wd_target_222222222222";

describe("rebaseState", () => {
  const v2 = {
    version: 2,
    id: "session_old",
    cwd: "/old/place",
    title: "auth investigation",
    agents: {
      main: { homedir: `${OLD_DIR}/agents/main`, type: "main", parentAgentId: null },
      "agent-0": { homedir: `${OLD_DIR}/agents/agent-0`, type: "sub", parentAgentId: "main" },
    },
  };

  it("moves the directory, the id and EVERY agent home to the clone", () => {
    const rebased = rebaseState(v2, TARGET)!;
    expect(rebased.workDirKey).toBe("cwd");
    expect(rebased.state.cwd).toBe("/new/target");
    // Version-2 metadata names itself, and kimi trusts that over the
    // folder: a kept id resumes as "Session not found".
    expect(rebased.state.id).toBe("session_new");
    expect(rebased.state.agents).toEqual({
      main: { homedir: `${TARGET.sessionDir}/agents/main`, type: "main", parentAgentId: null },
      "agent-0": { homedir: `${TARGET.sessionDir}/agents/agent-0`, type: "sub", parentAgentId: "main" },
    });
    expect(rebased.state.title).toBe("auth investigation");
  });

  it("keeps the older era's key and invents neither a cwd nor an id", () => {
    const { id: _id, cwd: _cwd, version: _v, ...rest } = v2;
    const rebased = rebaseState({ ...rest, workDir: "/old/place" }, TARGET)!;
    expect(rebased.workDirKey).toBe("workDir");
    expect(rebased.state.workDir).toBe("/new/target");
    expect("cwd" in rebased.state).toBe(false);
    expect("id" in rebased.state).toBe(false);
  });

  it("leaves an agent entry without a home as it was", () => {
    const state = { ...v2, agents: { ...v2.agents, odd: { type: "sub" } } };
    expect((rebaseState(state, TARGET)!.state.agents as Record<string, unknown>).odd)
      .toEqual({ type: "sub" });
  });

  it("refuses a layout it does not know", () => {
    const { cwd: _cwd, ...noDir } = v2;
    expect(rebaseState(noDir, TARGET)).toBeNull();
    expect(rebaseState({ ...v2, agents: { "agent-0": v2.agents["agent-0"] } }, TARGET)).toBeNull();
    expect(rebaseState({ ...v2, agents: undefined }, TARGET)).toBeNull();
  });
});

describe("rebaseWire", () => {
  const binding = { type: "runtime.set_binding", workspaceId: "wd_a_111111111111", runtimeId: "local", agentId: "main", time: 5 };
  const bind = {
    type: "profile.bind",
    agentId: "main",
    profileName: "agent",
    modelAlias: "kimi-code/k3",
    thinkingEffort: "high",
    systemPrompt: "The current working directory is `/old/place`.",
    environmentDisclosure: { cwd: "/old/place" },
    disallowedTools: [],
    time: 7,
  };
  const legacyPrompt = { type: "config.update", profileName: "agent", systemPrompt: "… `/old/place` …", time: 9 };
  const model = { type: "config.update", modelAlias: "kimi-code/k3", thinkingEffort: "high", time: 11 };
  const turn = { type: "turn.prompt", input: "cd /old/place", time: 13 };
  const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");
  const parsed = (text: string) => text.split("\n").map((line) => JSON.parse(line));

  it("points every runtime binding at the clone's workspace — in any agent", () => {
    for (const agent of ["main", "agent-0"]) {
      const [record] = parsed(rebaseWire(lines(binding), agent, WS));
      expect(record).toEqual({ ...binding, workspaceId: WS });
    }
  });

  it("drops the main agent's saved prompt in place, as a no-op record", () => {
    const out = parsed(rebaseWire(lines(bind, legacyPrompt), "main", WS));
    expect(out[0]).toEqual({ type: "config.update", agentId: "main", time: 7 });
    // An older kimi's render: the prompt and the profile name go — a
    // replayed profileName alone stops kimi rendering a fresh profile.
    expect(out[1]).toEqual({ type: "config.update", time: 9 });
  });

  it("keeps settings and conversation untouched", () => {
    const text = lines(model, turn);
    expect(rebaseWire(text, "main", WS)).toBe(text);
  });

  it("keeps a subagent's prompt — kimi does not re-render a child's", () => {
    const text = lines(bind, legacyPrompt);
    expect(rebaseWire(text, "agent-0", WS)).toBe(text);
  });

  it("is line for line: blanks, broken lines and the final newline survive", () => {
    // kimi addresses records by line and stops at the first unparseable
    // one — moving either would change what it replays.
    const text = `${JSON.stringify(binding)}\n\n{ half a rec\n${JSON.stringify(bind)}\n`;
    const out = rebaseWire(text, "main", WS).split("\n");
    expect(out).toHaveLength(5);
    expect(out[1]).toBe("");
    expect(out[2]).toBe("{ half a rec");
    expect(out[4]).toBe("");
    expect(JSON.parse(out[3]).type).toBe("config.update");
  });

  it("leaves non-object lines and a binding without a workspace alone", () => {
    const text = lines([1, 2], "str", { type: "runtime.set_binding", runtimeId: "local" });
    expect(rebaseWire(text, "main", WS)).toBe(text);
  });
});
