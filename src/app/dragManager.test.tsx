// @vitest-environment happy-dom
import { act, createElement, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePointerDrag } from "./dragManager";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function pointerEvent(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    isPrimary: { value: true },
    pointerId: { value: init.pointerId ?? 1 },
  });
  return event;
}

describe("usePointerDrag", () => {
  let host: HTMLDivElement;
  let root: Root;
  let events: string[];
  let clicks: number;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    clicks = 0;
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function Probe({ label }: { label: string }) {
    const drag = usePointerDrag<{ id: string }>({
      holdMs: 300,
      cancelBeforeStartPx: 10,
      onStart: () => events.push(`start:${label}`),
      onMove: () => events.push(`move:${label}`),
      onDrop: () => events.push(`drop:${label}`),
    });
    return createElement(
      "button",
      {
        id: "source",
        onClick: () => {
          clicks += 1;
        },
        onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) =>
          drag.startPointerDrag(event.nativeEvent, { id: "source" }),
      },
      "drag",
    );
  }

  const render = (label: string) =>
    act(() => root.render(createElement(Probe, { label })));

  const source = () => document.getElementById("source")!;

  it("arms a long-press drag at 300ms and uses the latest callbacks", () => {
    render("old");
    act(() => {
      source().dispatchEvent(pointerEvent("pointerdown", { clientY: 0 }));
      vi.advanceTimersByTime(299);
    });
    expect(events).toEqual([]);

    act(() => vi.advanceTimersByTime(1));
    expect(events).toEqual(["start:old"]);

    render("new");
    act(() =>
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 4 })),
    );
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientY: 4 })));
    expect(events).toEqual(["start:old", "move:new", "drop:new"]);
  });

  it("cancels a pending hold when the pointer drifts too far", () => {
    render("only");
    act(() => {
      source().dispatchEvent(pointerEvent("pointerdown", { clientY: 0 }));
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 11 }));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 11 }));
    });
    expect(events).toEqual([]);
  });

  it("suppresses the synthesized click after a completed drag", () => {
    render("only");
    act(() => {
      source().dispatchEvent(pointerEvent("pointerdown"));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointerEvent("pointerup"));
      source().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicks).toBe(0);
  });
});
