// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeckStatusStrip,
  type DeckStatusStripProps,
} from "./DeckStatusStrip";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The chips own their stores and their own tests; here they would only drag
// usage state into questions about what the strip says.
vi.mock("../usage/UsageChips", () => ({
  UsageChips: () => createElement("span", { "data-usage": "" }),
}));

const BASE: DeckStatusStripProps = {
  paneCount: 2,
  version: "0.21.13",
  agents: [],
  usageLiveAgents: new Set(),
  onOpenStats: () => {},
  updateAction: null,
  onUpdateAction: () => {},
};

describe("DeckStatusStrip", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (props: Partial<DeckStatusStripProps> = {}) =>
    act(() => root.render(createElement(DeckStatusStrip, { ...BASE, ...props })));

  const status = () => host.querySelector(".deck__status")?.textContent ?? "";
  const updateButton = () =>
    host.querySelector<HTMLButtonElement>(".deck__statusbar-update");

  it("counts one agent as a pane, not as panes", () => {
    // The count is read at a glance and never in isolation — a wrong plural
    // is the kind of thing nobody reports and everybody notices.
    render({ paneCount: 1 });
    expect(status()).toContain("1 pane");
    expect(status()).not.toContain("panes");
    render({ paneCount: 0 });
    expect(status()).toContain("0 panes");
  });

  it("waits for the build number rather than inventing one", () => {
    // `app_info` answers asynchronously, and until it does there is no honest
    // version to print beside the count.
    render({ version: null });
    expect(status().trim()).toBe("2 panes");
    render({ version: "0.21.13" });
    expect(status()).toContain("· 0.21.13");
  });

  it("stays quiet when there is no update", () => {
    render();
    expect(updateButton()).toBeNull();
  });

  it("hands the update control's own action back, and honours its refusal", () => {
    const onUpdateAction = vi.fn();
    render({
      updateAction: {
        label: "Update ready · Restart",
        title: "Update to 0.22.0 and restart",
        disabled: false,
        action: { kind: "restart" },
      },
      onUpdateAction,
    });
    act(() => updateButton()?.click());
    // The strip never decides what an update press means — it returns the
    // action it was handed.
    expect(onUpdateAction).toHaveBeenCalledWith({ kind: "restart" });

    render({
      updateAction: {
        label: "Downloading update…",
        title: "Version 0.22.0 is available",
        disabled: true,
        action: { kind: "openUpdatesSettings" },
      },
    });
    expect(updateButton()?.disabled).toBe(true);
  });
});
