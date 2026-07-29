import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../plugins";
import {
  buildAgentFeatureCatalog,
  projectAgentFeatureRows,
} from "./agentFeatureCatalog";

function cliPlugin(
  pluginId: string,
  agentId: string,
  features: NonNullable<
    NonNullable<
      InstalledPlugin["manifest"]["contributes"]["agents"]
    >[number]["features"]
  >,
): InstalledPlugin {
  return {
    manifest: {
      id: pluginId,
      name: pluginId,
      version: "1.0.0",
      minApiVersion: 30,
      category: "cli",
      capabilities: [],
      contributes: {
        agents: [
          {
            id: agentId,
            label: agentId,
            bin: agentId,
            features,
          },
        ],
      },
    },
    source: "builtin",
    status: { kind: "active" },
  };
}

describe("buildAgentFeatureCatalog", () => {
  it("discovers unknown features and chooses metadata independently of install order", () => {
    const later = cliPlugin("z.plugin", "z-agent", [
      { id: "vendor.future", label: "Z label", group: "custom" },
    ]);
    const owner = cliPlugin("a.plugin", "a-agent", [
      { id: "vendor.future", label: "A label", group: "custom" },
    ]);

    expect(buildAgentFeatureCatalog([later, owner])).toEqual(
      buildAgentFeatureCatalog([owner, later]),
    );
    expect(buildAgentFeatureCatalog([later, owner])).toEqual([
      { id: "vendor.future", label: "A label", group: "custom" },
    ]);
  });
});

describe("projectAgentFeatureRows", () => {
  it("puts unsupported features last and renders null and empty array parameters", () => {
    const catalog = [
      { id: "target.remote", label: "Remote targets" },
      { id: "session.new", label: "New sessions" },
      { id: "vendor.future", label: "Future feature" },
    ];
    const rows = projectAgentFeatureRows(catalog, [
      {
        id: "vendor.future",
        label: "Future feature",
        parameters: {
          values: [null, "ready"],
          empty: [],
        },
      },
      { id: "session.new", label: "New sessions" },
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      "session.new",
      "vendor.future",
      "target.remote",
    ]);
    expect(rows[1].stateText).toBe(
      "Supported · values: none, ready; empty: none",
    );
    expect(rows[2].stateText).toBe("Not supported");
  });
});
