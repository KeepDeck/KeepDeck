import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  AgentContributionSummary,
  AgentFeatureDeclaration,
} from "@keepdeck/plugin-api";
import { validateAgentFeatureImplementations } from "./agentFeatures";

const feature = (
  id: string,
  over: Partial<AgentFeatureDeclaration> = {},
): AgentFeatureDeclaration => ({
  id,
  label: id,
  ...over,
});

const summary = (
  features?: AgentFeatureDeclaration[],
): AgentContributionSummary => ({
  id: "example",
  label: "Example",
  bin: "example",
  ...(features !== undefined ? { features } : {}),
});

const implementation = (
  over: Partial<AgentContribution> = {},
): AgentContribution => ({
  id: "example",
  label: "Example",
  detect: { bin: "example" },
  hooks: {},
  ...over,
});

describe("validateAgentFeatureImplementations", () => {
  it("accepts one manifest declaration backed by runtime implementations", () => {
    expect(() =>
      validateAgentFeatureImplementations(
        summary([
          feature("session.new"),
          feature("session.resume"),
          feature("session.fork"),
          feature("session.history"),
          feature("usage.pane"),
          feature("usage.account"),
          feature("execution.yolo"),
          feature("target.remote", {
            parameters: { schemes: ["ws", "wss"] },
          }),
          feature("vendor.informational"),
        ]),
        implementation({
          hooks: {
            "spawn.plan": () => {},
            "resume.plan": () => {},
            "fork.plan": () => {},
          },
          history: {
            list: async () => [],
            describe: async () => ({ cwd: "" }),
            content: async () => "",
            transcript: async () => [],
          },
          usage: { normalize: () => null },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a declared operation without its implementation", () => {
    expect(() =>
      validateAgentFeatureImplementations(
        summary([feature("session.resume")]),
        implementation(),
      ),
    ).toThrow('feature "session.resume" requires a resume.plan');
  });

  it("rejects an implementation omitted from the authoritative manifest", () => {
    expect(() =>
      validateAgentFeatureImplementations(
        summary([]),
        implementation({ hooks: { "fork.plan": () => {} } }),
      ),
    ).toThrow(
      'fork.plan implementation requires manifest feature "session.fork"',
    );
  });

  it("rejects duplicate legacy declaration fields for featured manifests", () => {
    expect(() =>
      validateAgentFeatureImplementations(
        summary([feature("execution.yolo")]),
        implementation({ supportsYolo: true }),
      ),
    ).toThrow(
      "runtime supportsYolo duplicates the manifest feature declaration",
    );
  });

  it("retains the legacy contract only when no feature list exists", () => {
    expect(() =>
      validateAgentFeatureImplementations(
        summary(),
        implementation({ supportsYolo: true }),
      ),
    ).not.toThrow();
  });

  it("validates remote schemes before the host can use them", () => {
    expect(() =>
      validateAgentFeatureImplementations(
        summary([
          feature("target.remote", {
            parameters: { schemes: ["ftp"] },
          }),
        ]),
        implementation(),
      ),
    ).toThrow('requires non-empty supported "schemes"');
  });
});
