import { describe, expect, it } from "vitest";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { breakdown } from "../../domain/usage/stats/fold";
import { dimensionKey } from "../../domain/usage/stats/dimensions";
import { teamHistory } from "../../domain/usage/stats/teams";
import { modelNames, sessionName, shortSession, teamName, workspaceName } from "./statsNames";

const models = (...rows: Parameters<typeof usageEvent>[0][]) =>
  breakdown(rows.map((row) => usageEvent(row)), [], (row) => dimensionKey("model", row), 5);

describe("model names", () => {
  it("names a model by the catalogue alone while the name is unique", () => {
    const rows = models({ agent: "claude", model: "anthropic/claude-opus-5-5", modelName: "Claude Opus 5.5", costUsd: 1 });
    expect([...modelNames(rows).values()]).toEqual([{ name: "Claude Opus 5.5", source: null }]);
  });

  it("tells two providers of one model apart by the provider", () => {
    const rows = models(
      { agent: "opencode", model: "zai/glm-5.3", modelName: "GLM-5.3", costUsd: 2 },
      { agent: "opencode", model: "opencode/glm-5.3", modelName: "GLM-5.3", costUsd: 1 },
    );
    expect([...modelNames(rows).values()].map((n) => n.source)).toEqual(["zai", "opencode"]);
  });

  it("falls back to the agent for a twin booked before per-model usage", () => {
    const rows = models(
      { agent: "codex", model: "gpt-5", costUsd: 2 },
      { agent: "kimi", model: "gpt-5", costUsd: 1 },
    );
    expect([...modelNames(rows).values()].map((n) => n.source)).toEqual(["codex", "kimi"]);
  });

  it("names the closing row by how many groups it holds", () => {
    const rows = breakdown(
      ["a", "b", "c", "d"].map((id, i) => usageEvent({ model: `p/${id}`, modelName: id, workspaceName: id, costUsd: 9 - i })),
      [],
      (row) => dimensionKey("model", row),
      2,
    );
    const [, , closing] = rows;
    if (closing === undefined) throw new Error("no closing row");
    expect(modelNames(rows).get(closing.key)).toEqual({ name: "2 more", source: null });
    expect(workspaceName(closing)).toEqual({ name: "2 more", source: null });
  });
});

describe("session names", () => {
  it("keeps the first eight characters of a long id, and a short id whole", () => {
    expect(shortSession("session-123456789")).toBe("session-…");
    expect(shortSession("123456789012")).toBe("123456789012");
    expect(shortSession("1234567890123")).toBe("12345678…");
    expect(shortSession(undefined)).toBe("Unknown session");
    expect(shortSession("")).toBe("Unknown session");
  });

  it("names a session by its pane, else its id, and says where and by whom", () => {
    const [named] = breakdown([usageEvent({ paneName: "auth-refactor", workspaceName: "KeepDeck", agent: "codex" })], [], () => "s", 5);
    const [bare] = breakdown([usageEvent({ paneName: "", sessionId: "session-123456789", workspaceName: "", agent: "kimi" })], [], () => "s", 5);
    if (named === undefined || bare === undefined) throw new Error("no rows");
    expect(sessionName(named)).toEqual({ name: "auth-refactor", source: "KeepDeck · codex" });
    expect(sessionName(bare)).toEqual({ name: "session-…", source: "kimi" });
  });
});

describe("team names", () => {
  it("says how much of a group was attributed by inference, beside its workspace", () => {
    const history = teamHistory({}, new Map());
    const [group] = breakdown(
      [usageEvent({ workspaceName: "KeepDeck", team: { kind: "member", id: "t", name: "stats", role: "lead" } })],
      [],
      () => "t",
      5,
    );
    if (group === undefined) throw new Error("no rows");
    expect(teamName(group, history, "recorded")).toEqual({ name: "stats", source: "KeepDeck" });
    expect(teamName(group, history, "inferred")).toEqual({ name: "stats", source: "KeepDeck · inferred" });
    expect(teamName(group, history, "mixed")).toEqual({ name: "stats", source: "KeepDeck · partly inferred" });
  });

  it("names a recorded no-team group and an unknown one apart", () => {
    const history = teamHistory({}, new Map());
    const [none] = breakdown([usageEvent({ team: { kind: "none" } })], [], () => "n", 5);
    const [unknown] = breakdown([usageEvent({})], [], () => "u", 5);
    if (none === undefined || unknown === undefined) throw new Error("no rows");
    expect(teamName(none, history, "recorded").name).toBe("No team");
    expect(teamName(unknown, history, "recorded").name).toBe("Team unknown");
  });
});
