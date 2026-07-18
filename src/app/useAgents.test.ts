// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContribution, Disposable } from "@keepdeck/plugin-api";
import type { BinStatus } from "../ipc/agents";
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
const runtime = {
  plugins: {
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
  supportsYolo: true,
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

  const register = (agent: AgentContribution) => {
    registered.push(pluginRegistries.agents.add("test-plugin", agent));
  };

  beforeEach(() => {
    ipc.detectBins.mockReset();
    resetAgentsCache();
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
      { bin: "claude", installed: false, path: null },
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
        supportsYolo: true,
        installed: false,
        path: null,
        reportsUsage: false,
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

  it("a remount seeds from the cached detection instead of flashing installed", async () => {
    register(claude);
    ipc.detectBins.mockResolvedValue([
      { bin: "claude", installed: false, path: "/usr/local/bin/claude" },
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
