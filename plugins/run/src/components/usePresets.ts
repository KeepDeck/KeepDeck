import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import { isRunPresets, type RunPreset } from "../domain";
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
  // The slot is named by the workspace's id + instance; the caller may hand
  // a fresh object for the same slot. Read the latest object through a ref
  // rather than re-subscribing to its identity.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => {
    let alive = true;
    const slot = ctx.storage.workspace(workspaceRef.current);
    const load = () => {
      void slot.get("presets", isRunPresets).then((stored) => {
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
      void ctx.storage.workspace(workspaceRef.current).set("presets", next);
      setPresets(next);
    },
    [ctx],
  );

  return [presets, save];
}
