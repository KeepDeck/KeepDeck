// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { welcomeView } from "../../presentation/welcomeView";
import { WelcomeScreen } from "./WelcomeScreen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 10 * 86_400_000;
const agents = [{ label: "claude", installed: true }];
const projects = Array.from({ length: 7 }, (_, i) => ({ root: `/Users/me/p${i}`, sessions: i + 1, lastAt: NOW - i * 1000 }));

describe("WelcomeScreen", () => {
  let host: HTMLDivElement;
  let root: Root;
  let unpin: () => void;
  beforeEach(() => {
    installResizeObserver();
    unpin = pinListViewport("welcome__projects", 400, 600, 52);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    unpin();
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const render = (view: ReturnType<typeof welcomeView>, handlers = { onOpenFolder: vi.fn(), onChoose: vi.fn(), onShowAll: vi.fn() }) => {
    act(() => root.render(createElement(WelcomeScreen, { view, ...handlers })));
    return handlers;
  };

  it("greets, offers the one way in, names the steps and the agents found — and no list on a first run", () => {
    const handlers = render(welcomeView({ projects: [], showAll: false, agents, now: NOW }));
    expect(host.querySelector(".welcome__title")?.textContent).toBe("Welcome to KeepDeck");
    expect(host.querySelectorAll(".welcome__steps li")).toHaveLength(3);
    expect(host.querySelector(".welcome__agents")?.textContent).toContain("claude");
    expect(host.querySelector(".welcome__recent")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".welcome__open")!.click());
    expect(handlers.onOpenFolder).toHaveBeenCalledOnce();
  });

  it("lists the recent projects, a click handing on the project's folder, and asks for the rest", () => {
    const handlers = render(welcomeView({ projects, showAll: false, agents, now: NOW }));
    expect(host.querySelector(".welcome__title")?.textContent).toBe("Welcome back");
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".welcome__project")];
    expect(rows.map((row) => row.querySelector(".welcome__project-name")?.textContent)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    act(() => rows[2].click());
    expect(handlers.onChoose).toHaveBeenCalledWith("/Users/me/p2");
    act(() => host.querySelector<HTMLButtonElement>(".welcome__more")!.click());
    expect(handlers.onShowAll).toHaveBeenCalledOnce();
  });
});
