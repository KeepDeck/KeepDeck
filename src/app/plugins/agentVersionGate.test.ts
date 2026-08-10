import { describe, expect, it } from "vitest";
import { API_VERSION, type PluginManifest } from "@keepdeck/plugin-api";
import { binOfAgent, probeableBinOfAgent } from "./agentVersionGate";

const manifest = (
  id: string,
  over: Partial<PluginManifest> = {},
): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  minApiVersion: API_VERSION,
  category: "cli",
  capabilities: [],
  contributes: {},
  ...over,
});

const contributed = (pluginId: string, agentId: string, bin: string) => ({
  pluginId,
  entry: { id: agentId, detect: { bin } },
});

/**
 * The one rule between a manifest field and a process being started.
 *
 * It used to be an inline condition inside the plugin manager's factory,
 * which no test could reach — and the only test that had ever bound the
 * property lived in the host, guarding a shape that no longer exists. A
 * probe RUNS somebody's binary, so the rule gets a test of its own.
 */
describe("probeableBinOfAgent", () => {
  it("offers a bin the owning plugin declared and consented to run", () => {
    const owner = manifest("keepdeck.codex", {
      capabilities: [{ kind: "exec", commands: ["codex"] }],
      contributes: { agents: [{ id: "codex", label: "Codex", bin: "codex" }] },
    });
    expect(
      probeableBinOfAgent(
        [contributed("keepdeck.codex", "codex", "codex")],
        [{ manifest: owner }],
        "codex",
      ),
    ).toBe("codex");
  });

  it("refuses a bin no exec capability covers", () => {
    // Declaring an agent is not consent to run it. The capability is what
    // the user approved, and it is the whole gate.
    const owner = manifest("keepdeck.sneaky", {
      capabilities: [],
      contributes: { agents: [{ id: "sneaky", label: "S", bin: "curl" }] },
    });
    expect(
      probeableBinOfAgent(
        [contributed("keepdeck.sneaky", "sneaky", "curl")],
        [{ manifest: owner }],
        "sneaky",
      ),
    ).toBeNull();
  });

  it("refuses a bin the owner's manifest never declared", () => {
    // The bin comes from the runtime CONTRIBUTION, which is plugin code
    // talking. The permission comes from the manifest, which is what the
    // user saw. A contribution naming something the manifest does not is
    // exactly the case the two-source check exists for.
    const owner = manifest("keepdeck.codex", {
      capabilities: [{ kind: "exec", commands: ["codex", "curl"] }],
      contributes: { agents: [{ id: "codex", label: "Codex", bin: "codex" }] },
    });
    expect(
      probeableBinOfAgent(
        [contributed("keepdeck.codex", "codex", "curl")],
        [{ manifest: owner }],
        "codex",
      ),
    ).toBeNull();
  });

  it("will not let one plugin ride on another's consent", () => {
    // The permission has to come from the manifest that OWNS the agent. A
    // rule that asked the installed set as a whole — a union of everyone's
    // probeable bins — would let a plugin that declared nothing be probed
    // because somebody else had consented to that binary.
    const consenting = manifest("keepdeck.codex", {
      capabilities: [{ kind: "exec", commands: ["codex"] }],
      contributes: { agents: [{ id: "codex", label: "Codex", bin: "codex" }] },
    });
    const freeloader = manifest("dev.freeloader", {
      capabilities: [],
      contributes: { agents: [{ id: "mine", label: "Mine", bin: "codex" }] },
    });
    expect(
      probeableBinOfAgent(
        [contributed("dev.freeloader", "mine", "codex")],
        [{ manifest: consenting }, { manifest: freeloader }],
        "mine",
      ),
    ).toBeNull();
  });

  it("refuses an agent whose plugin is no longer installed", () => {
    // Uninstalled between the contribution being read and this being asked:
    // there is no manifest left to consult, so there is no consent.
    expect(
      probeableBinOfAgent(
        [contributed("gone.plugin", "ghost", "ghost-cli")],
        [],
        "ghost",
      ),
    ).toBeNull();
  });

  it("refuses an agent nobody contributed", () => {
    expect(probeableBinOfAgent([], [], "nobody")).toBeNull();
  });
});

describe("binOfAgent", () => {
  it("answers what an agent runs, and null for one nobody contributed", () => {
    const agents = [contributed("keepdeck.codex", "codex", "codex")];
    expect(binOfAgent(agents, "codex")).toBe("codex");
    expect(binOfAgent(agents, "absent")).toBeNull();
  });
});
