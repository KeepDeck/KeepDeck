import { describe, expect, it } from "vitest";
import type { AgentContribution } from "@keepdeck/plugin-api";
import {
  contributionSupportsFork,
  contributionSupportsHistory,
  contributionSupportsResume,
} from "./implementation";

const implementation = (
  over: Partial<AgentContribution> = {},
): AgentContribution => ({
  id: "example",
  label: "Example",
  detect: { bin: "example" },
  hooks: {},
  ...over,
});

describe("runtime implementation predicates", () => {
  it("recognizes only callable implementations", () => {
    const agent = implementation({
      hooks: {
        "resume.plan": () => {},
        "fork.plan": () => {},
      },
      history: {
        list: async () => [],
        describe: async () => ({ cwd: "" }),
        content: async () => "",
        transcript: async () => [],
      },
    });
    expect(contributionSupportsResume(agent)).toBe(true);
    expect(contributionSupportsFork(agent)).toBe(true);
    expect(contributionSupportsHistory(agent)).toBe(true);
  });
});
