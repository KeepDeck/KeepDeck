// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MinimizedTray,
  type MinimizedTrayEntry,
  visibleTrayItemCount,
} from "./MinimizedTray";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("visibleTrayItemCount", () => {
  it("shows every natural-width item when the row fits exactly", () => {
    // 200 + 210 + 220px items + 2 × 8px gaps.
    expect(visibleTrayItemCount(646, [200, 210, 220])).toBe(3);
  });

  it("reserves the last slot for an explicit overflow control", () => {
    expect(visibleTrayItemCount(645, [200, 210, 220])).toBe(2);
    // 200px item + 8px gap + 48px overflow control.
    expect(visibleTrayItemCount(256, [200, 210, 220])).toBe(1);
    expect(visibleTrayItemCount(255, [200, 210, 220])).toBe(0);
  });

  it("handles empty and single-item trays without inventing overflow", () => {
    expect(visibleTrayItemCount(1000, [])).toBe(0);
    expect(visibleTrayItemCount(272, [272])).toBe(1);
  });

  it("caps pathological measurements at the visual 272px maximum", () => {
    expect(visibleTrayItemCount(328, [400, 100])).toBe(1);
  });
});

describe("MinimizedTray", () => {
  let root: Root;
  let viewportWidth: number;
  let measuredItemWidths: number[];
  let resizeCallback: ResizeObserverCallback = () => {};
  let rectSpy: ReturnType<typeof vi.spyOn>;
  const restores = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];

  const entries: MinimizedTrayEntry[] = restores.map((onRestore, index) => ({
    id: `pane-${index + 1}`,
    title: `Agent ${index + 1}`,
    gitBadge: {
      label: `fix/branch-${index + 1}`,
      title: `fix/branch-${index + 1}`,
    },
    label: `Restore Agent ${index + 1}`,
    onRestore,
  }));

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 700 },
    });
    viewportWidth = 640;
    measuredItemWidths = [208, 216, 224, 232];
    restores.forEach((restore) => restore.mockClear());

    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("deck__tray-items")) {
          return domRect({ width: viewportWidth, right: viewportWidth });
        }
        if (this.classList.contains("minimized--measure")) {
          const index = Array.from(this.parentElement?.children ?? []).indexOf(
            this,
          );
          const width = measuredItemWidths[index] ?? 272;
          return domRect({
            width,
            right: width,
            height: 26,
            bottom: 26,
          });
        }
        if (this.classList.contains("minimized-overflow__trigger")) {
          return domRect({
            top: 650,
            bottom: 676,
            left: 600,
            right: 648,
            width: 48,
            height: 26,
          });
        }
        if (this.classList.contains("minimized-overflow")) {
          return domRect({ width: 288, height: 150, right: 288, bottom: 150 });
        }
        return domRect();
      });

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document.documentElement, "clientWidth");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  it("keeps one row and exposes only the entries represented by +N", async () => {
    act(() =>
      root.render(createElement(MinimizedTray, { entries, active: true })),
    );

    expect(document.querySelector(".deck__tray-label")?.textContent).toBe(
      "Minimized · 4",
    );
    expect(
      document.querySelectorAll(".deck__tray-items .minimized--chip"),
    ).toHaveLength(2);
    const overflow = document.querySelector<HTMLButtonElement>(
      ".minimized-overflow__trigger",
    )!;
    expect(overflow.textContent).toBe("+2");
    expect(overflow.getAttribute("aria-label")).toBe(
      "Show 2 more minimized agents",
    );
    expect(overflow.getAttribute("aria-expanded")).toBe("false");

    act(() => overflow.click());
    const popover = document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(popover.getAttribute("aria-label")).toBe("Minimized agents");
    expect(popover.getAttribute("aria-modal")).toBe("false");
    expect(document.activeElement).toBe(popover);
    expect(popover.style.width).toBe("248px");
    expect(
      popover.querySelectorAll(".minimized-overflow__list .minimized--chip"),
    ).toHaveLength(2);
    expect(popover.textContent).not.toContain("Agent 1");
    expect(popover.textContent).not.toContain("Agent 2");
    expect(popover.textContent).toContain("Agent 3");
    expect(popover.textContent).toContain("Agent 4");
    expect(overflow.getAttribute("aria-expanded")).toBe("true");

    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(overflow);

    act(() => overflow.click());
    const reopened = document.querySelector<HTMLElement>("[role='dialog']")!;

    const fourth = reopened.querySelector<HTMLButtonElement>(
      "[aria-label='Restore Agent 4']",
    )!;
    act(() => fourth.click());
    expect(restores[3]).toHaveBeenCalledOnce();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );
    expect(document.activeElement).toBe(overflow);
  });

  it("removes overflow when a resize makes every item fit", () => {
    act(() =>
      root.render(createElement(MinimizedTray, { entries, active: true })),
    );
    expect(document.querySelector(".minimized-overflow__trigger")).not.toBeNull();

    viewportWidth = 1120;
    act(() => resizeCallback([], {} as ResizeObserver));

    expect(
      document.querySelectorAll(".deck__tray-items .minimized--chip"),
    ).toHaveLength(4);
    expect(document.querySelector(".minimized-overflow__trigger")).toBeNull();
  });

  it("suppresses its portaled dialog when the source workspace deactivates", () => {
    act(() =>
      root.render(createElement(MinimizedTray, { entries, active: true })),
    );
    const overflow = document.querySelector<HTMLButtonElement>(
      ".minimized-overflow__trigger",
    )!;
    act(() => overflow.click());
    expect(document.querySelector("[role='dialog']")).not.toBeNull();

    act(() =>
      root.render(createElement(MinimizedTray, { entries, active: false })),
    );
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(overflow.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps focus on a restore action while an open dialog repositions", () => {
    act(() =>
      root.render(createElement(MinimizedTray, { entries, active: true })),
    );
    const overflow = document.querySelector<HTMLButtonElement>(
      ".minimized-overflow__trigger",
    )!;
    act(() => overflow.click());
    const restore = document.querySelector<HTMLButtonElement>(
      "[aria-label='Restore Agent 4']",
    )!;
    act(() => restore.focus());
    expect(document.activeElement).toBe(restore);

    measuredItemWidths = [208, 216, 224, 260];
    const updatedEntries = entries.map((entry) =>
      entry.id === "pane-4" ? { ...entry, title: "Renamed Agent 4" } : entry,
    );
    act(() =>
      root.render(
        createElement(MinimizedTray, {
          entries: updatedEntries,
          active: true,
        }),
      ),
    );

    expect(document.activeElement).toBe(restore);
    expect(
      document.querySelector<HTMLElement>("[role='dialog']")?.style.width,
    ).toBe("276px");
  });

  it("focuses the restored pane when restoring the last hidden entry removes +N", () => {
    viewportWidth = 0;
    let frame: FrameRequestCallback | null = null;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frame = callback;
        return 1;
      });

    function LastRestoreHarness() {
      const [restored, setRestored] = useState(false);
      const entry: MinimizedTrayEntry = {
        id: "last-pane",
        title: "Last agent",
        label: "Restore last agent",
        onRestore: () => setRestored(true),
      };
      return (
        <>
          <section
            data-pane-id="last-pane"
            tabIndex={-1}
            hidden={!restored}
          />
          {!restored && <MinimizedTray entries={[entry]} active />}
        </>
      );
    }

    act(() => root.render(<LastRestoreHarness />));
    const overflow = document.querySelector<HTMLButtonElement>(
      ".minimized-overflow__trigger",
    )!;
    act(() => overflow.click());
    const restore = document.querySelector<HTMLButtonElement>(
      "[aria-label='Restore last agent']",
    )!;
    act(() => restore.click());

    expect(document.querySelector(".minimized-overflow__trigger")).toBeNull();
    const pane = document.querySelector<HTMLElement>(
      "[data-pane-id='last-pane']",
    )!;
    expect(document.activeElement).not.toBe(pane);
    act(() => frame?.(0));
    expect(document.activeElement).toBe(pane);

    requestFrame.mockRestore();
  });
});

function domRect(
  overrides: Partial<DOMRect> = {},
): DOMRect {
  const left = overrides.left ?? 0;
  const top = overrides.top ?? 0;
  const width = overrides.width ?? 0;
  const height = overrides.height ?? 0;
  return {
    x: left,
    y: top,
    top,
    right: overrides.right ?? left + width,
    bottom: overrides.bottom ?? top + height,
    left,
    width,
    height,
    toJSON: () => ({}),
  };
}
