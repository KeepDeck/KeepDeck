import { useCallback, useEffect, useState } from "react";
import { DEFAULT_OPEN_APP, knownOpenApp } from "../domain";
import { getRuntime } from "../runtime";

/**
 * The workspace's "Open in" application pick, out of the plugin's
 * per-workspace storage slot — each workspace remembers its own editor.
 * Same hydration idiom as `usePresets`: read on mount, re-read on every
 * `onDeckChanged` (the coarse signal that fires once stored data has
 * hydrated), and mirror writes into local state so the pick applies
 * immediately without a round-trip.
 */
export function useOpenApp(wsId: string): [string, (app: string) => void] {
  const { ctx } = getRuntime();
  const [app, setApp] = useState(DEFAULT_OPEN_APP);

  useEffect(() => {
    let alive = true;
    const slot = ctx.storage.workspace(wsId);
    const load = () => {
      void slot.get("openApp").then((stored) => {
        if (alive) setApp(knownOpenApp(stored));
      });
    };
    load();
    const sub = ctx.events.onDeckChanged(load);
    return () => {
      alive = false;
      sub.dispose();
    };
  }, [ctx, wsId]);

  const save = useCallback(
    (next: string) => {
      void ctx.storage.workspace(wsId).set("openApp", next);
      setApp(next);
    },
    [ctx, wsId],
  );

  return [app, save];
}
