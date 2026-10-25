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
