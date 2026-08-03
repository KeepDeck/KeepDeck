// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AchievementEmbers } from "./AchievementEmbers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** A drawing surface the test DOM does not provide. Only the calls this
 * component makes are here — anything it starts using shows up as a
 * TypeError rather than as a silent no-op. */
function fakeContext() {
  return {
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D;
}

let root: Root;
let mounted = false;
/** The observers this component installs, captured so a test can drive the
 * callback the browser would call. */
let gates: ((entries: { isIntersecting: boolean }[]) => void)[] = [];

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeContext() as never,
  );
  gates = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        gates.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  mounted = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mount the field inside a card, the way the badge does. */
function render() {
  const host = document.createElement("div");
  host.className = "stats__achievement";
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(AchievementEmbers)));
  mounted = true;
  return host;
}

describe("AchievementEmbers", () => {
  it("puts a canvas inside the card for the glow to live on", () => {
    const host = render();
    const canvas = host.querySelector("canvas");
    expect(canvas).not.toBeNull();
    // The layer class is what keeps the card's content rules off this
    // element. Without it the canvas joins the flow, grows the card, and
    // the card's height feeds straight back into the canvas's own size.
    expect(canvas!.classList.contains("stats__achievement-layer")).toBe(true);
    expect(canvas!.classList.contains("stats__achievement-embers")).toBe(true);
    // Decorative: it carries no meaning a reader would miss.
    expect(canvas!.getAttribute("aria-hidden")).toBe("true");
  });

  it("runs a draw loop once it has a surface", () => {
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    render();
    expect(frame).toHaveBeenCalled();
  });

  it("draws nothing when the reader asked for less motion", () => {
    const matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    vi.stubGlobal("matchMedia", matchMedia);
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    render();
    expect(frame).not.toHaveBeenCalled();
    // The QUERY matters: a stub that matches everything would keep this
    // green while the component asked about something else entirely.
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("draws nothing on a canvas that has no 2d surface at all", () => {
    // A DOM without canvas support answers null, and the badge must still
    // mount — the glow is decoration, not the badge.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => null as never,
    );
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    const host = render();
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(frame).not.toHaveBeenCalled();
  });

  it("parks its loop while nothing is looking at it, and picks it up again", () => {
    // Thirty legendary badges are thirty draw loops; the dialog shows two
    // rows. The ones behind the scroll must cost nothing.
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    render();
    expect(gates).toHaveLength(1);
    const started = frame.mock.calls.length;

    act(() => gates[0]([{ isIntersecting: false }]));
    expect(cancel).toHaveBeenCalled();
    // A repeated off-screen report must not cancel a loop that is already
    // parked, nor a later frame that no longer exists.
    const cancelled = cancel.mock.calls.length;
    act(() => gates[0]([{ isIntersecting: false }]));
    expect(cancel.mock.calls.length).toBe(cancelled);
    expect(frame.mock.calls.length).toBe(started);

    act(() => gates[0]([{ isIntersecting: true }]));
    expect(frame.mock.calls.length).toBeGreaterThan(started);
  });

  it("stops its loop when the card goes away", () => {
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    render();
    act(() => root.unmount());
    mounted = false;
    expect(cancel).toHaveBeenCalled();
  });
});
