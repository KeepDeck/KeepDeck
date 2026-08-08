// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  AgentFeatureDeclaration,
  Disposable,
} from "@keepdeck/plugin-api";
import type { BinStatus } from "../ipc/agents";
import type { InstalledPlugin } from "../plugins";
import { createContributionRegistries } from "../plugins/registries/contributions";
import type { AppRuntime } from "./runtime";
import { AppRuntimeProvider } from "./runtimeContext";
import { resetAgentsCache, useAgents } from "./useAgents";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  detectBins: vi.fn<(bins: string[]) => Promise<BinStatus[]>>(),
}));
vi.mock("../ipc/agents", () => ipc);

const pluginRegistries = createContributionRegistries();
let installedPlugins: readonly InstalledPlugin[] = [];
const pluginHost = {
  subscribe: () => () => {},
  getInstalled: () => installedPlugins,
};
const runtime = {
  plugins: {
    pluginHost,
    pluginRegistries,
    bootstrapPlugins: () => Promise.resolve(),
  },
} as unknown as AppRuntime;

const claude: AgentContribution = {
  id: "claude",
  label: "Claude Code",
  icon: {
    viewBox: "0 0 24 24",
    paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
  },
  detect: { bin: "claude" },
  hooks: {},
};

let seen: ReturnType<typeof useAgents>;
function Probe() {
  seen = useAgents();
  return null;
}

describe("useAgents", () => {
  let root: Root;
  let registered: Disposable[] = [];

  const register = (
    agent: AgentContribution,
    features: AgentFeatureDeclaration[] = [
      { id: "execution.yolo", label: "YOLO mode" },
    ],
  ) => {
    installedPlugins = [
      {
        manifest: {
          id: "test-plugin",
          name: "Test plugin",
          version: "1.0.0",
          minApiVersion: 30,
          category: "cli",
          capabilities: [],
          contributes: {
            agents: [
              {
                id: agent.id,
                label: agent.label,
                bin: agent.detect.bin,
                features,
              },
            ],
          },
        },
        source: "builtin",
        status: { kind: "active" },
      },
    ];
    registered.push(pluginRegistries.agents.add("test-plugin", agent));
  };

  beforeEach(() => {
    ipc.detectBins.mockReset();
    resetAgentsCache();
    installedPlugins = [];
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const d of registered) d.dispose();
    registered = [];
  });

  const mount = () =>
    act(async () =>
      root.render(
        createElement(AppRuntimeProvider, { runtime }, createElement(Probe)),
      ),
    );

  it("assembles the catalog from agent contributions plus detection", async () => {
    register(claude);
    ipc.detectBins.mockResolvedValue([
      { bin: "claude", installed: false, path: null, version: null },
    ]);
    await mount();
    expect(ipc.detectBins).toHaveBeenCalledWith(["claude"]);
    expect(seen.agents).toEqual([
      {
        id: "claude",
        label: "Claude Code",
        icon: {
          viewBox: "0 0 24 24",
          paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
        },
        command: "claude",
        features: [{ id: "execution.yolo", label: "YOLO mode" }],
        installed: false,
        path: null,
        usageAvailable: false,
      },
    ]);
    expect(seen.loading).toBe(false);
  });

  it("counts a bin as installed until its status arrives", async () => {
    register(claude);
    ipc.detectBins.mockReturnValue(new Promise(() => {})); // never settles
    await mount();
    expect(seen.agents[0]?.installed).toBe(true);
  });

  it("projects usage features from the manifest", async () => {
    register(
      {
        ...claude,
        usage: { normalize: () => null },
      },
      [{ id: "usage.pane", label: "Pane usage" }],
    );
    ipc.detectBins.mockResolvedValue([
      { bin: "claude", installed: true, path: "/usr/bin/claude", version: "2.1.226" },
    ]);
    await mount();
    expect(seen.agents[0]?.features).toEqual([
      { id: "usage.pane", label: "Pane usage" },
    ]);
  });

  it("projects a remote feature and its parameters from the manifest", async () => {
    register(
      {
        ...claude,
        detect: { bin: "codex" },
      },
      [
        {
          id: "target.remote",
          label: "Remote targets",
          parameters: { schemes: ["ws", "wss"] },
        },
      ],
    );
    ipc.detectBins.mockResolvedValue([
      { bin: "codex", installed: true, path: "/usr/bin/codex", version: "0.147.0" },
    ]);
    await mount();
    expect(seen.agents[0]?.features).toEqual([
      {
        id: "target.remote",
        label: "Remote targets",
        parameters: { schemes: ["ws", "wss"] },
      },
    ]);
  });

  it("a remount seeds from the cached detection instead of flashing installed", async () => {
    register(claude);
    ipc.detectBins.mockResolvedValue([
      { bin: "claude", installed: false, path: "/usr/local/bin/claude", version: null },
    ]);
    await mount();
    act(() => root.unmount());

    // The remount's re-detect is still in flight — the cached status stands.
    ipc.detectBins.mockReturnValue(new Promise(() => {}));
    root = createRoot(document.getElementById("host")!);
    await mount();
    expect(seen.agents[0]?.installed).toBe(false);
    expect(seen.agents[0]?.path).toBe("/usr/local/bin/claude");
  });

  it("an empty registry after boot is an honest empty catalog", async () => {
    await mount();
    expect(seen.agents).toEqual([]);
    expect(seen.loading).toBe(false);
    expect(ipc.detectBins).not.toHaveBeenCalled();
  });
});
