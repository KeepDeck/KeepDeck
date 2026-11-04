/**
 * Make every canvas answer `getContext` with a test's own fake context.
 *
 * A 2D context has some seventy members, and a fake answers only those the
 * code under test draws with — so it cannot honestly be a typed
 * CanvasRenderingContext2D, and spying `getContext` through its typed
 * overloads took a cast to pretend it was. The fake goes in through the
 * DOM's own untyped door instead: a property definition, undone by the
 * returned restore.
 */
export function stubCanvasContext(make: (canvas: HTMLCanvasElement) => object | null): () => void {
  const proto = HTMLCanvasElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "getContext");
  Object.defineProperty(proto, "getContext", {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      return make(this);
    },
  });
  return () => {
    if (original) Object.defineProperty(proto, "getContext", original);
    else Reflect.deleteProperty(proto, "getContext");
  };
}

/**
 * A 2D context that accepts every call: enough surface for xterm to lay out
 * cells, rasterize glyphs and paint rows. Every image it is asked to draw is
 * pushed onto `drawn`, for a test that cares where glyphs come from.
 */
export function recordingContext2d(canvas: unknown, drawn: unknown[]): object {
  const state: Record<string | symbol, unknown> = {};
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    measureText: () => ({
      width: 8,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    }),
    getImageData: (_x, _y, w, h) => ({
      width: w,
      height: h,
      // Opaque ink everywhere, so glyph trimming finds something to keep.
      data: new Uint8ClampedArray(Math.max(1, Number(w) * Number(h)) * 4).fill(255),
    }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: (image) => {
      drawn.push(image);
    },
  };
  return new Proxy(state, {
    get(target, key) {
      if (key === "canvas") return canvas;
      if (typeof key === "string" && key in methods) return methods[key];
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}
