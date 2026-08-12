// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import {
  notify,
  resetNotificationCenter,
} from "../../app/notificationCenter";
import { NotificationBell } from "./NotificationBell";

vi.mock("../../ipc/notify", () => ({
  sendSystemNotification: vi.fn(),
  ensureNotificationPermission: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => null, // defaults: enabled, system-and-app
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const paneSource = {
  type: "pane",
  workspace: { id: "ws-1", instance: createWorkspaceInstance() },
  paneId: "p-1",
} as const;

describe("NotificationBell", () => {
  let root: Root;
  const onOpen = vi.fn();

  beforeEach(() => {
    resetNotificationCenter();
    onOpen.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => {
      root.render(createElement(NotificationBell, { onOpen }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    resetNotificationCenter();
  });

  const bellButton = () =>
    document.querySelector<HTMLButtonElement>(".bell__button")!;

  it("shows no badge when everything is read, counts unread otherwise", () => {
    expect(document.querySelector(".bell__badge")).toBeNull();
    act(() => {
      notify({ title: "one", source: paneSource });
      notify({ title: "two", source: { type: "app" } });
    });
    expect(document.querySelector(".bell__badge")?.textContent).toBe("2");
  });

  it("opens an empty panel with the empty state", () => {
    act(() => bellButton().click());
    expect(document.querySelector(".bell__empty")?.textContent).toBe(
      "Nothing yet",
    );
  });

  it("lists notifications newest first with title, body and severity", () => {
    act(() => {
      notify({ title: "first", body: "b1", source: paneSource });
      notify({
        title: "second",
        severity: "error",
        source: { type: "app" },
      });
    });
    act(() => bellButton().click());
    const titles = [...document.querySelectorAll(".bell__item-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["second", "first"]);
    expect(document.querySelector(".bell__dot--error")).not.toBeNull();
    expect(document.querySelector(".bell__body")?.textContent).toBe("b1");
  });

  it("uses one leading slot without ornamenting routine info", () => {
    act(() => {
      notify({ title: "badge", icon: "💎", source: { type: "app" } });
      notify({ title: "plain", source: { type: "app" } });
      notify({
        title: "warning",
        severity: "warning",
        source: { type: "app" },
      });
    });
    act(() => bellButton().click());
    const items = [...document.querySelectorAll(".bell__item")];
    expect(document.querySelectorAll(".bell__leading")).toHaveLength(3);
    const badge = items.find((item) => item.textContent?.includes("badge"))!;
    expect(badge.querySelector(".bell__icon")?.textContent).toBe("💎");
    expect(badge.querySelector(".bell__dot")).toBeNull();
    const plain = items.find((item) => item.textContent?.includes("plain"))!;
    expect(plain.querySelector(".bell__icon")).toBeNull();
    expect(plain.querySelector(".bell__dot")).toBeNull();
    expect(plain.querySelector(".bell__leading")?.childElementCount).toBe(0);
    const warning = items.find((item) =>
      item.textContent?.includes("warning"),
    )!;
    expect(warning.querySelector(".bell__dot--warning")).not.toBeNull();
  });

  it("clicking an entry marks it read, closes the panel and navigates", () => {
    act(() => {
      notify({ title: "crash", source: paneSource });
    });
    act(() => bellButton().click());
    act(() => {
      document.querySelector<HTMLButtonElement>(".bell__item")!.click();
    });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: "crash", source: paneSource }),
    );
    expect(document.querySelector(".bell__panel")).toBeNull();
    expect(document.querySelector(".bell__badge")).toBeNull(); // read
  });

  it("mark-all-read clears the badge but keeps history clearable", () => {
    act(() => {
      notify({ title: "a", source: paneSource });
      notify({ title: "b", source: paneSource });
    });
    act(() => bellButton().click());
    act(() => {
      document.querySelector<HTMLButtonElement>(".bell__mark-read")!.click();
    });
    expect(document.querySelector(".bell__badge")).toBeNull();
    expect(document.querySelector(".bell__mark-read")).toBeNull();
    expect(document.querySelector(".bell__clear-all")).not.toBeNull();
    // The list itself stays — history, not an inbox purge.
    expect(document.querySelectorAll(".bell__item")).toHaveLength(2);
  });

  it("clear-all empties history without closing the panel", () => {
    act(() => {
      notify({ title: "a", source: paneSource });
      notify({ title: "b", source: paneSource });
    });
    act(() => bellButton().click());
    act(() => {
      document.querySelector<HTMLButtonElement>(".bell__clear-all")!.click();
    });
    expect(document.querySelector(".bell__panel")).not.toBeNull();
    expect(document.querySelector(".bell__empty")?.textContent).toBe(
      "Nothing yet",
    );
    expect(document.querySelector(".bell__badge")).toBeNull();
    expect(document.querySelector(".bell__actions")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a second press on the bell button closes the panel exactly once", () => {
    act(() => bellButton().click());
    expect(document.querySelector(".bell__panel")).not.toBeNull();
    // The button lives INSIDE the light-dismiss root: its pointerdown must
    // not race the onClick toggle into a close-then-reopen.
    act(() => {
      bellButton().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      bellButton().click();
    });
    expect(document.querySelector(".bell__panel")).toBeNull();
  });

  it("Escape and an outside press both dismiss the panel", () => {
    act(() => bellButton().click());
    expect(document.querySelector(".bell__panel")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".bell__panel")).toBeNull();

    act(() => bellButton().click());
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(document.querySelector(".bell__panel")).toBeNull();
  });
});
