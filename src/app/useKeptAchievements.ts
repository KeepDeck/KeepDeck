import { useSyncExternalStore } from "react";
import { useRuntimePart } from "./runtimeContext";

/** The awards already given, live — see [`createKeptAchievements`]. */
export function useKeptAchievements(): ReadonlySet<string> {
  const kept = useRuntimePart("keptAchievements");
  return useSyncExternalStore(kept.subscribe, kept.getSnapshot);
}
