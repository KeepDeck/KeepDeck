// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import {
  createAgentStatusTracker,
  type AgentStatusTracker,
} from "../../app/agentStatusTracker";
import { AppRuntimeProvider } from "../../app/runtimeContext";
import type { AppRuntime } from "../../app/runtime";
import {
  MINIMIZED_TOOLTIP_DELAY_MS,
  MinimizedItem,
} from "./MinimizedItem";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MinimizedItem", () => {
  let root: Root;
  let statusTracker: AgentStatusTracker;
  const onClick = vi.fn();

  const render = (props: ComponentProps<typeof MinimizedItem>) =>
    act(() => {
      root.render(
        createElement(
          AppRuntimeProvider,
          { runtime: { statusTracker } as unknown as AppRuntime },
          createElement(MinimizedItem, props),
        ),
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    statusTracker = createAgentStatusTracker();
    statusTracker.registerNormalizer(
      "claude",
      (payload) => (payload as { edge?: AgentStatusEvent }).edge ?? null,
    );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    onClick.mockClear();
    render({
      variant: "chip",
      paneId: "pane-1",
      title: "A deliberately long agent title",
      gitBadge: {
        label: "fix/a-deliberately-long-branch",
        title: "fix/a-deliberately-long-branch",
      },
      label: "Restore A deliberately long agent title",
      active: true,
      onClick,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("places the stopped marker right of the title, before the badges", () => {
    render({
      variant: "bar",
      paneId: "pane-1",
      title: "Claude 1",
      label: "Restore Claude 1",
      stopped: true,
      yolo: true,
      active: true,
      onClick,
    });
    const title = document.querySelector(".minimized__title")!;
    const marker = document.querySelector(".minimized__stopped")!;
    const yolo = document.querySelector(".minimized__yolo")!;
    expect(
      title.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      marker.compareDocumentPosition(yolo) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a YOLO pane keeps its warning marker in the stand-in; a plain one doesn't", () => {
    // The beforeEach mount carries no yolo — the marker must be absent.
    expect(document.querySelector(".minimized__yolo")).toBeNull();

    render({
      variant: "bar",
      paneId: "pane-1",
      title: "Claude 1",
      label: "Restore Claude 1",
      yolo: true,
      active: true,
      onClick,
    });
    const marker = document.querySelector<HTMLElement>(".minimized__yolo")!;
    expect(marker.querySelector("svg")).not.toBeNull();
    expect(marker.title).toContain("without permission prompts");
  });

  it("replaces native title bubbles with full details after hover intent", () => {
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    expect(button.title).toBe("");
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    act(() => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(MINIMIZED_TOOLTIP_DELAY_MS - 1);
    });
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']")!;
    expect(tooltip.textContent).toContain("A deliberately long agent title");
    expect(tooltip.textContent).toContain("fix/a-deliberately-long-branch");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);

    act(() =>
      button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
    );
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("shows the same details immediately for keyboard focus", () => {
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    act(() => button.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "fix/a-deliberately-long-branch",
    );

    act(() => button.blur());
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("closes details and restores the agent on click", () => {
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    act(() => button.focus());
    act(() => button.click());

    expect(onClick).toHaveBeenCalledOnce();
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("wears the pane's status frame — attention must survive minimizing", () => {
    let button = document.querySelector<HTMLButtonElement>(".minimized")!;
    expect(button.className).not.toContain("minimized--frame");

    act(() =>
      statusTracker.report("pane-1", {
        agent: "claude",
        edge: { kind: "waiting", at: Date.now(), reason: "permission" },
      }),
    );
    button = document.querySelector<HTMLButtonElement>(".minimized")!;
    expect(button.className).toContain("minimized--frame-waiting");

    act(() =>
      statusTracker.report("pane-1", {
        agent: "claude",
        edge: { kind: "turn-end", at: Date.now() },
      }),
    );
    button = document.querySelector<HTMLButtonElement>(".minimized")!;
    // No selection in the tray: done shows on its own rung.
    expect(button.className).toContain("minimized--frame-done");
  });

  it("a retired pane's stand-in is bare — the tracker is the one authority", () => {
    // Suspend goes through the orchestrator's retire, which clears the
    // pane's activity; the stand-in renders the store verbatim and derives
    // no liveness gate of its own.
    act(() =>
      statusTracker.report("pane-1", {
        agent: "claude",
        edge: { kind: "waiting", at: Date.now(), reason: "permission" },
      }),
    );
    act(() => statusTracker.clear("pane-1"));
    render({
      variant: "chip",
      paneId: "pane-1",
      title: "Claude 1",
      label: "Restore Claude 1",
      stopped: true,
      active: true,
      onClick,
    });
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    expect(button.className).not.toContain("minimized--frame");
  });
});
