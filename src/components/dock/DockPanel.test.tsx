// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockPanel, type DockTabItem } from "./DockPanel";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string, label: string): DockTabItem => ({
  id,
  label,
  element: createElement("div", { "data-body": id }, label),
});

const TABS = [tab("p:one", "One"), tab("p:two", "Two"), tab("p:three", "Three")];

describe("DockPanel (controlled tab)", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (props: Parameters<typeof DockPanel>[0]) =>
    act(() => root.render(createElement(DockPanel, props)));

  const activeLabel = () =>
    host.querySelector(".dock__tab--active")?.textContent ?? null;
  const tabButtons = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));

  it("marks the caller's picked tab selected", () => {
    render({ tabs: TABS, activeTab: "p:two", onSelectTab: () => {} });
    expect(activeLabel()).toBe("Two");
    const selected = host.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
  });

  it("calls onSelectTab with the clicked tab's id", () => {
    const onSelectTab = vi.fn();
    render({ tabs: TABS, activeTab: "p:one", onSelectTab });
    act(() => tabButtons()[2].click());
    expect(onSelectTab).toHaveBeenCalledWith("p:three");
  });

  it("falls back to the first tab when nothing is picked yet", () => {
    render({ tabs: TABS, activeTab: null, onSelectTab: () => {} });
    expect(activeLabel()).toBe("One");
  });

  it("falls back to the first tab when the picked tab has vanished", () => {
    // Its plugin was disabled; the dock must not render empty.
    render({ tabs: TABS, activeTab: "p:gone", onSelectTab: () => {} });
    expect(activeLabel()).toBe("One");
  });

  it("keeps every tab body mounted, hiding the inactive ones", () => {
    render({ tabs: TABS, activeTab: "p:two", onSelectTab: () => {} });
    const bodies = host.querySelectorAll<HTMLElement>(".dock__body");
    expect(bodies).toHaveLength(3);
    const shown = Array.from(bodies).filter((b) => !b.hidden);
    expect(shown).toHaveLength(1);
    expect(shown[0].querySelector("[data-body]")?.getAttribute("data-body")).toBe(
      "p:two",
    );
  });
});
