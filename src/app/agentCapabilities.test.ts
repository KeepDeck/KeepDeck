import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  AgentContributionSummary,
} from "@keepdeck/plugin-api";
import {
  contributionSupportsFork,
  contributionSupportsHistory,
  contributionSupportsResume,
  projectAgentFeatures,
} from "./agentCapabilities";

const implementation = (
  over: Partial<AgentContribution> = {},
): AgentContribution => ({
  id: "example",
  label: "Example",
  detect: { bin: "example" },
  hooks: {},
  ...over,
});

const summary = (
  over: Partial<AgentContributionSummary> = {},
): AgentContributionSummary => ({
  id: "example",
  label: "Example",
  bin: "example",
  ...over,
});

describe("agent feature projection", () => {
  it("uses the manifest verbatim as the authoritative declaration", () => {
    const features = [
      {
        id: "vendor.future-feature",
        label: "Future feature",
        group: "custom",
        parameters: { mode: "fast" },
      },
    ];
    const projected = projectAgentFeatures(
      summary({ features }),
      implementation({
        supportsYolo: true,
        hooks: { "resume.plan": () => {} },
      }),
    );
    expect(projected).toBe(features);
  });

  it("derives a compatibility projection only for legacy manifests", () => {
    const projected = projectAgentFeatures(
      summary(),
      implementation({
        supportsYolo: true,
        remote: { mode: "nativeServer", schemes: ["ws", "wss"] },
        usage: {
          capabilities: ["paneTelemetry", "accountLimits"],
          normalize: () => null,
        },
        history: {
          list: async () => [],
          describe: async () => ({ cwd: "" }),
          content: async () => "",
          transcript: async () => [],
        },
        hooks: {
          "resume.plan": () => {},
          "fork.plan": () => {},
        },
      }),
    );
    expect(projected.map((feature) => feature.id)).toEqual([
      "session.new",
      "session.resume",
      "session.fork",
      "session.history",
      "usage.pane",
      "usage.account",
      "execution.yolo",
      "target.remote",
    ]);
  });
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
