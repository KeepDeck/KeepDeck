// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../domain/agents";
import { resetAgentsCache, useAgents } from "./useAgents";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  listAgents: vi.fn<() => Promise<AgentInfo[]>>(),
}));
vi.mock("../ipc/agents", () => ipc);

const CATALOG: AgentInfo[] = [
  { id: "claude", label: "Claude Code", command: "claude", installed: true, path: null },
];

let seen: { agents: AgentInfo[]; loading: boolean };
function Probe() {
  seen = useAgents();
  return null;
}

describe("useAgents", () => {
  let root: Root;

  beforeEach(() => {
    ipc.listAgents.mockReset();
    resetAgentsCache();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => act(() => root.unmount()));

  const mount = () => act(async () => root.render(createElement(Probe)));

  it("starts empty and loading on the very first mount", async () => {
    ipc.listAgents.mockReturnValue(new Promise(() => {})); // never settles
    await mount();
    expect(seen.agents).toEqual([]);
    expect(seen.loading).toBe(true);
  });

  it("a remount seeds from the last catalog instead of flashing empty", async () => {
    ipc.listAgents.mockResolvedValue(CATALOG);
    await mount();
    expect(seen.agents).toEqual(CATALOG);
    act(() => root.unmount());

    // The remount's re-detect fetch is still in flight — the previous
    // catalog stands in, so the picker never renders empty.
    ipc.listAgents.mockReturnValue(new Promise(() => {}));
    root = createRoot(document.getElementById("host")!);
    await mount();
    expect(seen.agents).toEqual(CATALOG);
    expect(seen.loading).toBe(false);
  });
});
