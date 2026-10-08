// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import type { AgentInfo } from "../../domain/agents";
import { useWelcomeFlow } from "../../app/useWelcomeFlow";
import { WelcomeStage } from "./WelcomeStage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The session index's owner, as the runtime hands it out: a revision a test
// moves, and the needs declared on it.
const index = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = { scanning: false, revision: 0, invalidated: new Set<string>() };
  return {
    needs: 0,
    manager: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensureFresh: () => void (index.needs += 1),
    },
    publish: () => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../app/runtimeContext", () => ({ useAppRuntime: () => ({ sessionIndex: index.manager }) }));
const projects = vi.hoisted(() => ({ current: [] as { root: string; sessions: number; lastAt: number }[] }));
vi.mock("../../ipc/history", () => ({ recentProjects: () => Promise.resolve(projects.current) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [{ id: "claude", label: "claude", installed: true }] as unknown as AgentInfo[];

describe("WelcomeStage", () => {
  let host: HTMLDivElement;
  let root: Root;
  let created: unknown[];
  let picked: string | null;
  let unpin: () => void;
  beforeEach(() => {
    installResizeObserver();
    unpin = pinListViewport("welcome__projects", 400, 600, 52);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    created = [];
    picked = "/Users/me/fresh";
    index.needs = 0;
    projects.current = [];
  });
  afterEach(() => {
    unpin();
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function Harness() {
    const flow = useWelcomeFlow(() => Promise.resolve(picked));
    return createElement(WelcomeStage, {
      flow,
      agents,
      onCreate: (config) => created.push(config),
      pickFolder: () => Promise.resolve(null),
      inspectDir: () => Promise.resolve({ isRepo: false, branch: null }),
    });
  }
  const mount = () => act(async () => root.render(createElement(Harness)));
  const names = () => [...host.querySelectorAll(".welcome__project-name")].map((n) => n.textContent);

  it("asks the index to be fresh, and fills the list as the index publishes", async () => {
    await mount();
    expect(index.needs).toBe(1);
    expect(names()).toEqual([]);
    projects.current = [{ root: "/Users/me/KeepDeck", sessions: 3, lastAt: Date.now() }];
    await act(async () => index.publish());
    expect(names()).toEqual(["KeepDeck"]);
  });

  it("opens a folder, confirms it named after it, and creates it — Back returning to the choice", async () => {
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>(".welcome__open")!.click());
    const name = () => host.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]');
    expect(name()?.value).toBe("fresh");
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Back")!.click());
    expect(host.querySelector(".welcome")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".welcome__open")!.click());
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(created).toEqual([{ name: "fresh", cwd: "/Users/me/fresh", worktreeBaseDir: null }]);
    // The next time there is no workspace, the welcome starts over — not on this confirm.
    expect(host.querySelector(".welcome")).not.toBeNull();
  });

  it("takes a recent project straight to confirming it", async () => {
    projects.current = [{ root: "/Users/me/KeepDeck", sessions: 3, lastAt: Date.now() }];
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>(".welcome__project")!.click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]')?.value).toBe("KeepDeck");
  });

  it("stays on the choice when the picker closes without a folder", async () => {
    picked = null;
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>(".welcome__open")!.click());
    expect(host.querySelector(".welcome")).not.toBeNull();
    expect(host.querySelector("form")).toBeNull();
  });
});
