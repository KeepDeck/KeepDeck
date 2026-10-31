/**
 * One section of a 1.x plugin client (`session`, `tui`, …), shaped as
 * opencode's generated SDK shapes it: its methods reach their transport
 * through `this` (`Session.get` reads `this._client` in @opencode-ai/sdk's
 * sdk.gen.js), so one pulled off the section and called bare throws.
 *
 * A plain object of arrow functions answers a bare call as happily as a
 * method call, and that is how a lookup calling `get` bare passed every
 * suite while the real client refused it: every session read as "unknown",
 * and the deck refused every mail ask (task-569). A double of the client is
 * built from these, so a bare call fails here as it fails in opencode.
 */
export function sdkSection<M extends object>(methods: M): M {
  const section: M = new Proxy(methods, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]): unknown {
        if (this !== section) {
          throw new TypeError(`${String(key)} called without its section: the generated client reads this._client`);
        }
        return Reflect.apply(value, section, args);
      };
    },
  });
  return section;
}

/** A resource started in an armed test pane must expose its hook map. */
export type Armed<T, K extends keyof T> = T & { [P in K]-?: Exclude<T[P], undefined> };

export function requireHooks<T extends object, K extends keyof T>(
  hooks: T,
  names: readonly K[],
): Armed<T, K>;
export function requireHooks<T extends object, K extends keyof T>(
  hooks: T,
  names: readonly K[],
): T {
  for (const name of names) {
    if (typeof hooks[name] !== "function") {
      throw new Error(`Resource did not start hook ${String(name)}`);
    }
  }
  return hooks;
}
