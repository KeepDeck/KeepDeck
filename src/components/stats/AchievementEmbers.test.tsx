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

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeContext() as never,
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
    expect(canvas!.className).toBe("stats__achievement-embers");
    // Decorative: it carries no meaning a reader would miss.
    expect(canvas!.getAttribute("aria-hidden")).toBe("true");
  });

  it("runs a draw loop once it has a surface", () => {
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    render();
    expect(frame).toHaveBeenCalled();
  });

  it("draws nothing when the reader asked for less motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    render();
    expect(frame).not.toHaveBeenCalled();
  });

  it("stops its loop when the card goes away", () => {
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    render();
    act(() => root.unmount());
    mounted = false;
    expect(cancel).toHaveBeenCalled();
  });
});
