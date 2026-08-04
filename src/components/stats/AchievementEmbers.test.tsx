// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AchievementEmbers, reseed, seedField } from "./AchievementEmbers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The card the stylesheet would give this field: a 158×93 padding box plus
 * 26px of halo on every side. The test DOM lays nothing out, so the one
 * number the component reads is supplied here. */
const BOX = { width: 210, height: 145 };
const HALO = 26;

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
let context: CanvasRenderingContext2D;
/** The observers this component installs, captured so a test can drive the
 * callback the browser would call. */
let gates: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
let motionListeners: (() => void)[] = [];

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      addEventListener: (_: string, listener: () => void) =>
        motionListeners.push(listener),
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => {
  context = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as never,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...BOX,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: BOX.width,
    bottom: BOX.height,
    toJSON: () => ({}),
  });
  gates = [];
  motionListeners = [];
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

/** Let the browser's own frame callback run — the loop is scheduled through
 * requestAnimationFrame, which the test DOM defers to a later task, so a
 * suite that never waits here proves only that the loop was SCHEDULED. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
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

  it("sizes its bitmap from its own box, scaled for the display", () => {
    const host = render();
    const canvas = host.querySelector("canvas")!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    expect(canvas.width).toBe(BOX.width * ratio);
    expect(canvas.height).toBe(BOX.height * ratio);
    // Drawing happens in CSS pixels; the transform is what makes that true.
    expect(context.setTransform).toHaveBeenCalledWith(ratio, 0, 0, ratio, 0, 0);
  });

  it("draws a field of embers, all of them inside the bitmap", async () => {
    render();
    await frame();

    const calls = (context.drawImage as unknown as ReturnType<typeof vi.fn>).mock
      .calls as [unknown, number, number, number, number][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, x, y, w, h] of calls) {
      // The halo is the drift room. If it were ever too small for the
      // distance an ember travels plus its own glow, sparks would be cut off
      // by a straight line at the card's edge — which is what the inset
      // exists to prevent, and what no other test would notice.
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(BOX.width);
      expect(y + h).toBeLessThanOrEqual(BOX.height);
    }
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, BOX.width, BOX.height);
  });

  it("keeps every spark inside the card that emits it", async () => {
    render();
    await frame();

    // Spawn is the CARD, not the canvas: the glow is the badge radiating,
    // so a spark appearing out in the halo would read as debris.
    const calls = (context.drawImage as unknown as ReturnType<typeof vi.fn>).mock
      .calls as [unknown, number, number, number, number][];
    for (const [, x, y, w, h] of calls) {
      const centreX = x + w / 2;
      const centreY = y + h / 2;
      expect(centreX).toBeGreaterThan(HALO - 13);
      expect(centreX).toBeLessThan(BOX.width - HALO + 13);
      expect(centreY).toBeGreaterThan(HALO - 13);
      expect(centreY).toBeLessThan(BOX.height - HALO + 13);
    }
  });

  it("draws nothing when the reader asked for less motion", async () => {
    stubMatchMedia(true);
    render();
    await frame();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("stops when the reader asks for less motion with the dialog open", async () => {
    const media = { matches: false };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return media.matches;
        },
        addEventListener: (_: string, listener: () => void) =>
          motionListeners.push(listener),
        removeEventListener: () => {},
      })),
    );
    render();
    await frame();
    expect(context.drawImage).toHaveBeenCalled();

    // The CSS half of this decision re-evaluates the moment the setting
    // changes; sampling it once left the canvas as the one thing still moving.
    media.matches = true;
    act(() => motionListeners.forEach((listener) => listener()));
    (context.drawImage as unknown as ReturnType<typeof vi.fn>).mockClear();
    await frame();
    await frame();
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it("draws nothing on a canvas that has no 2d surface at all", async () => {
    // A DOM without canvas support answers null, and the badge must still
    // mount — the glow is decoration, not the badge.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => null as never,
    );
    const host = render();
    await frame();
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it("parks its loop while nothing is looking at it, and picks it up again", async () => {
    // Thirty legendary badges are thirty draw loops; the dialog shows two
    // rows. The ones behind the scroll must cost nothing.
    render();
    await frame();
    expect(gates).toHaveLength(1);

    act(() => gates[0]([{ isIntersecting: false }]));
    (context.drawImage as unknown as ReturnType<typeof vi.fn>).mockClear();
    await frame();
    await frame();
    expect(context.drawImage).not.toHaveBeenCalled();

    act(() => gates[0]([{ isIntersecting: true }]));
    await frame();
    expect(context.drawImage).toHaveBeenCalled();
  });

  it("stops its loop when the card goes away", () => {
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    render();
    act(() => root.unmount());
    mounted = false;
    expect(cancel).toHaveBeenCalled();
  });
});

describe("the ember field", () => {
  const phases = (now: number, field: ReturnType<typeof seedField>) =>
    new Set(field.map((spark) => now - spark.born));

  it("starts every ember at its own point in its own life", () => {
    const field = seedField(1_000);
    expect(field).toHaveLength(24);
    // A field born together flashes as one; a field mid-flight glows.
    expect(phases(1_000, field).size).toBeGreaterThan(20);
    expect([...phases(1_000, field)].every((age) => age >= 0)).toBe(true);
  });

  it("covers the card with exactly one ember per cell", () => {
    // Independent random points clump, and a clump reads as "all the sparks
    // are in one corner"; a shorter pool cycling through cells leaves a gap
    // that travels. One per cell is the only arrangement with neither.
    const cells = seedField(0).map((spark) => spark.cell);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it("puts a resumed field back mid-flight, not all at the starting line", () => {
    // The regression: a field parked behind the scroll came back with every
    // ember reborn on the same frame at phase zero, so the badge went dark,
    // bloomed at nearly twice its steady brightness, and troughed — and the
    // whole grid did it in step, since the observer reports newly visible
    // cards in one batch.
    const field = seedField(0);
    reseed(field, 5_000);
    expect(phases(5_000, field).size).toBeGreaterThan(20);
    // Same cells, so the coverage the grid buys is not lost on resume.
    expect(new Set(field.map((spark) => spark.cell)).size).toBe(field.length);
  });
});
