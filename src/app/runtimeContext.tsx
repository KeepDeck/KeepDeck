import { createContext, useContext, type ReactNode } from "react";
import type { AppRuntime } from "./runtime";

const RuntimeContext = createContext<AppRuntime | null>(null);

export function AppRuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime;
  children?: ReactNode;
}) {
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("AppRuntimeProvider is missing");
  return runtime;
}
