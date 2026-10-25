import { createContext, useContext, type ReactNode } from "react";
import type { AppRuntime } from "./runtime";

/**
 * The runtime as views reach it: one part at a time.
 *
 * The app hands over the whole runtime; a view asks only for the part it
 * reads (`useRuntimePart("statusTracker")`). So a test renders a view over
 * just the parts it reads, typed, and a view that starts reading a part its
 * test did not give fails by that part's name — where a context handing out
 * the whole runtime made every test build half of it and cast the rest.
 */
export type RuntimeParts = Partial<AppRuntime>;

const RuntimeContext = createContext<RuntimeParts | null>(null);

export function AppRuntimeProvider({
  runtime,
  children,
}: {
  runtime: RuntimeParts;
  children?: ReactNode;
}) {
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntimePart<K extends keyof AppRuntime>(part: K): AppRuntime[K] {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("AppRuntimeProvider is missing");
  const value = runtime[part];
  if (value === undefined) throw new Error(`the runtime has no ${part}`);
  return value;
}
