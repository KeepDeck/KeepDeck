import { useCallback, useEffect, useState } from "react";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import { openInFailed } from "../domain";
import { getRuntime } from "../runtime";

/**
 * The workspace's "Open in" application pick, out of the plugin's
 * per-workspace storage slot — each workspace remembers its own editor.
 * The raw pick, NOT validated against the settings list here: the caller
 * resolves it via `resolveOpenApp`, so a pick temporarily missing from the
 * list survives in storage and comes back when the app is re-added.
 * Same hydration idiom as `usePresets`: read on mount, re-read on every
 * `onDeckChanged`, mirror writes into local state. It also owns the act of
 * opening — the opener call and what a refusal leaves in the log — so the
 * tab only says "open this, in that".
 */
export function useOpenApp(workspace: WorkspaceRef): {
  pick: string | null;
  setPick(app: string): void;
  open(target: string, app: string): void;
} {
  const { ctx } = getRuntime();
  const [pick, setPick] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const slot = ctx.storage.workspace(workspace);
    const load = () => {
      void slot.get("openApp").then((stored) => {
        if (alive) setPick(typeof stored === "string" ? stored : null);
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
    (next: string) => {
      void ctx.storage.workspace(workspace).set("openApp", next);
      setPick(next);
    },
    [ctx, workspace.id, workspace.instance],
  );

  const open = useCallback(
    (target: string, app: string) => {
      void ctx.services.opener
        .openPathWith(target, app)
        .catch((error) => ctx.log.warn(openInFailed(target, app, error)));
    },
    [ctx],
  );

  return { pick, setPick: save, open };
}
