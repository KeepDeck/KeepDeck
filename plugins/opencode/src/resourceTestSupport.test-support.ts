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
