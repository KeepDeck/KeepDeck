// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const paneSource = { type: "pane", wsId: "ws-1", paneId: "p-1" } as const;

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

  it("mark-all-read clears the badge and the button disappears", () => {
    act(() => {
      notify({ title: "a", source: paneSource });
      notify({ title: "b", source: paneSource });
    });
    act(() => bellButton().click());
    act(() => {
      document.querySelector<HTMLButtonElement>(".bell__clear")!.click();
    });
    expect(document.querySelector(".bell__badge")).toBeNull();
    expect(document.querySelector(".bell__clear")).toBeNull();
    // The list itself stays — history, not an inbox purge.
    expect(document.querySelectorAll(".bell__item")).toHaveLength(2);
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
