import type { AppRuntime } from "./runtime";

/**
 * A stand-in for the runtime context module, for a test that mocks it
 * (`vi.mock(".../runtimeContext", async () => (await import(...)).
 * runtimePartsModule({ ... }))`): it answers the parts the test names, and
 * fails by name for any other — as the real `useRuntimePart` does. The part
 * names are checked: a typo is a compile error at the mock.
 */
export function runtimePartsModule(parts: Partial<Record<keyof AppRuntime, unknown>>) {
  return {
    useRuntimePart(part: keyof AppRuntime) {
      const value = parts[part];
      if (value === undefined) throw new Error(`the runtime has no ${part}`);
      return value;
    },
  };
}
