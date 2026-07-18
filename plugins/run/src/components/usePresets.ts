import { useCallback, useEffect, useState } from "react";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { RunPreset } from "../domain";
import { getRuntime } from "../runtime";

/**
 * The workspace's run presets, out of the plugin's per-workspace storage slot
 * (`ctx.storage.workspace(workspace)`), replacing the props the host RunTab took.
 *
 * Read on mount AND re-read on every `onDeckChanged` — the coarse "deck
 * changed" signal is what fires once the workspace's stored data has hydrated,
 * so a mount that raced ahead of hydration still fills in. The save path writes
 * the KV and then mirrors it into local state, so the list updates immediately
 * without waiting for a round-trip.
 */
export function usePresets(
  workspace: WorkspaceRef,
): [RunPreset[], (next: RunPreset[]) => void] {
  const { ctx } = getRuntime();
  const [presets, setPresets] = useState<RunPreset[]>([]);

  useEffect(() => {
    let alive = true;
    const slot = ctx.storage.workspace(workspace);
    const load = () => {
      void slot.get<RunPreset[]>("presets").then((stored) => {
        if (alive) setPresets(stored ?? []);
      });
    };
    load();
    const sub = ctx.events.onDeckChanged(load);
    return () => {
      alive = false;
      sub.dispose();
    };
  }, [ctx, workspace.id, workspace.instance]);

  const save = useCallback(
    (next: RunPreset[]) => {
      void ctx.storage.workspace(workspace).set("presets", next);
      setPresets(next);
    },
    [ctx, workspace.id, workspace.instance],
  );

  return [presets, save];
}
