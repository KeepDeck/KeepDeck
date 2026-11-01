import { describe, expect, it } from "vitest";
import { STAGING_TRIM_KINDS, type StagingTrim } from "../domain/skills";
import { stagingTrimLines } from "./stagingTrimsView";

const trim = (over: Partial<StagingTrim & { workspaceInstance: string; workspaceName: string }>) => ({
  scope: "global" as const,
  skill: "review",
  kind: "link-out" as const,
  path: null,
  count: 1,
  workspaceInstance: "life-web",
  workspaceName: "web",
  ...over,
});

describe("stagingTrimLines", () => {
  it("names the skill, or the path inside it, and what became of it", () => {
    const lines = stagingTrimLines([
      trim({ kind: "too-large" }),
      trim({ skill: "deploy", kind: "link-out", path: "lib/x", count: 3 }),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "review: larger than one skill may be — agents get its SKILL.md alone",
      "deploy/lib/x: links outside the skill — left out (and 2 more like it)",
    ]);
  });

  it("names a workspace skill's workspace, and says a global one once however many stages said it", () => {
    const lines = stagingTrimLines([
      trim({ workspaceInstance: "life-web", workspaceName: "web" }),
      trim({ workspaceInstance: "life-api", workspaceName: "api" }),
      trim({ scope: "workspace", skill: "mine", workspaceInstance: "life-web", workspaceName: "web" }),
      trim({ scope: "workspace", skill: "mine", workspaceInstance: "life-api", workspaceName: "api" }),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "review: links outside the skill — left out",
      "mine (in web): links outside the skill — left out",
      "mine (in api): links outside the skill — left out",
    ]);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
  });

  it("keeps two workspaces' skills apart even when the workspaces share a name — two things to fix", () => {
    const lines = stagingTrimLines([
      trim({ scope: "workspace", skill: "mine", workspaceInstance: "life-1", workspaceName: "web" }),
      trim({ scope: "workspace", skill: "mine", workspaceInstance: "life-2", workspaceName: "web" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.key)).size).toBe(2);
  });

  it("has words for every kind the stage can say", () => {
    const texts = STAGING_TRIM_KINDS.map((kind) => stagingTrimLines([trim({ kind })])[0].text);
    for (const text of texts) expect(text).toMatch(/^review: \S/);
    // Each kind says something of its own.
    expect(new Set(texts).size).toBe(STAGING_TRIM_KINDS.length);
  });
});
